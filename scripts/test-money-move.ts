// A moved account's Equicoins balance arriving from its old instance
// (money-federation.ts), against a migrated, disposable local database: taken
// once per old account however many imports it was the source of, never for a
// failed import, and at most MOVES_A_DAY moves' worth from a peer a day.
import { strict as assert } from "node:assert";
import { sql } from "../src/db";
import { peers } from "../src/federation";
import { newId } from "../src/ids";
import { MOVES_A_DAY, moneyFederationApi } from "../src/money-federation";
import { loadSettings, setSetting, settings } from "../src/settings";

const database = new URL(process.env.DATABASE_URL ?? "postgres://localhost/xitter");
assert(["localhost", "127.0.0.1"].includes(database.hostname) && /test|codex/.test(database.pathname), "Use a disposable local test database.");

await loadSettings();
const features = settings().features;
const peer = peers()[0]?.id;
assert(peer, "the bundled registry lists a peer");
const cap = 100 * settings().money.max_transfer_cents;
const recipient = newId();
const transfers: string[] = [];

const move = async (sourceUser: string, amount: number) => {
	const transferId = newId();
	transfers.push(transferId);
	const body = { transferId, sender: `${sourceUser}@${peer}`, recipient, amount, note: "", move: true };
	const bytes = new TextEncoder().encode(JSON.stringify(body));
	const res = await moneyFederationApi({ from: peer, nonce: "n".repeat(22), body: bytes, json: () => body }, "POST", "/federation/v1/money/transfer");
	return res!.status;
};
const migration = (sourceUser: string, state: string) =>
	sql`insert into account_migrations (id, user_id, source, source_user_id, source_handle, state)
		values (${newId()}::bigint, ${recipient}::bigint, ${`https://${peer}`}, ${sourceUser}::bigint, 'old', ${state})`;
const balance = async () => Number((await sql`select balance_cents from money_wallets where user_id = ${recipient}::bigint`)[0]?.balance_cents ?? 0);

try {
	await setSetting("features", { ...features, money: true });
	await sql`insert into users (id, screen_name, name, password_hash) values (${recipient}::bigint, ${`mv_${recipient.slice(-8)}`}, 'Moved', 'unused')`;
	await sql`insert into money_wallets (user_id, balance_cents) values (${recipient}::bigint, 0) on conflict (user_id) do update set balance_cents = 0`;
	const [first, second, third] = [newId(), newId(), newId()];

	assert.equal(await move(first, 1000), 403, "no import of that account: no move");
	await migration(first, "failed");
	assert.equal(await move(first, 1000), 403, "a failed import doesn't count");

	await migration(first, "running");
	const before = await balance();
	assert.equal(await move(first, cap / 2), 200, "a running import's move is taken");
	assert.equal((await balance()) - before, cap / 2);

	await sql`update account_migrations set state = 'done' where user_id = ${recipient}::bigint and state = 'running'`;
	await migration(first, "done");
	assert.equal(await move(first, 1000), 403, "a second import of the same account moves nothing more");

	// the rest of the day's allowance taken by other moves, but for one cent
	const filler = newId();
	transfers.push(filler);
	await sql`insert into money_federation_receipts (origin, transfer_id, amount_cents, move) values (${peer}, ${filler}::bigint, ${MOVES_A_DAY * cap - cap / 2 - 1}, true)`;
	assert.equal(await move(first, 1000), 403, "an account that already moved is told so even then, not asked to retry");
	await migration(second, "done");
	assert.equal(await move(second, 2), 429, "past a day's allowance, the peer is asked to retry later");
	assert.equal(await move(second, 1), 200, "up to it, another account's move is taken");
	await migration(third, "done");
	assert.equal(await move(third, 1), 429, "and then nothing more that day");
	console.log("ok: moved balances are taken once per account, never for a failed import, within a day's allowance");
} finally {
	await setSetting("features", features);
	await sql`delete from money_federation_receipts where origin = ${peer} and transfer_id = any(${sql.array(transfers, "INT8")})`;
	await sql`delete from users where id = ${recipient}::bigint`;
	await sql.close();
}
