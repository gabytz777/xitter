// X Money through the public API (/api/v1/money), against a migrated,
// disposable local database: the switch and the disclaimer, paying (once per
// idempotency key, never past the balance), requests of one account and
// "Pay @you" cards, who sees which payment, blocks, and earnings from likes.
import { strict as assert } from "node:assert";
import { sql } from "../src/db";
import { newId } from "../src/ids";
import { createToken, publicApi } from "../src/public-api";
import { PUBLIC_ORIGIN } from "../src/config";
import { loadSettings, setSetting, settings } from "../src/settings";

const database = new URL(process.env.DATABASE_URL ?? "postgres://localhost/xitter");
assert(["localhost", "127.0.0.1"].includes(database.hostname) && /test|codex/.test(database.pathname), "Use a disposable local test database.");

await loadSettings();
const features = settings().features;
const tag = newId().slice(-8);
const people = { a: newId(), b: newId(), c: newId() };
const handle = (k: keyof typeof people) => `xm${k}_${tag}`;
const call = async (token: string, method: string, path: string, body?: unknown) => {
	const url = new URL(`${PUBLIC_ORIGIN}/api/v1${path}`);
	const res = await publicApi(new Request(url, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined }), url);
	return { status: res.status, ...(await res.json()) };
};

try {
	for (const k of Object.keys(people) as (keyof typeof people)[]) await sql`insert into users(id, screen_name, name, password_hash) values(${people[k]}::bigint, ${handle(k)}, ${k.toUpperCase()}, 'unused')`;
	const tok = { a: await createToken(people.a, "t", "write"), b: await createToken(people.b, "t", "write"), c: await createToken(people.c, "t", "write"), aRead: await createToken(people.a, "r", "read") };

	// off unless the instance turns it on
	await setSetting("features", { ...features, money: false });
	assert.equal((await call(tok.a, "GET", "/money")).status, 404, "off: no money");
	await setSetting("features", { ...features, money: true });
	const start = settings().money.starting_cents;

	// the disclaimer comes first
	const w = await call(tok.a, "GET", "/money");
	assert.deepEqual([w.status, w.data.balance_cents, w.data.disclaimer_accepted], [200, start, false]);
	assert.match(w.data.disclaimer, /no real-world monetary value/);
	assert.equal((await call(tok.a, "POST", "/money/send", { to: handle("b"), amount_cents: 100, idempotency_key: `k-${tag}-0` })).status, 403, "nothing moves before the disclaimer");
	for (const t of [tok.a, tok.b, tok.c]) assert.equal((await call(t, "POST", "/money/disclaimer")).status, 200);

	// paying, once per key
	const key = `k-${tag}-1`;
	const sent = await call(tok.a, "POST", "/money/send", { to: handle("b"), amount_cents: 125, note: "lunch", idempotency_key: key });
	assert.equal(sent.status, 201);
	assert.deepEqual([sent.data.amount_cents, sent.data.note, sent.data.direction, sent.data.recipient.screen_name, sent.data.url], [125, "lunch", "sent", handle("b"), `${PUBLIC_ORIGIN}/i/xmoney/p/${sent.data.id}`]);
	const again = await call(tok.a, "POST", "/money/send", { to: handle("b"), amount_cents: 125, note: "lunch", idempotency_key: key });
	assert.deepEqual([again.status, again.data.id], [200, sent.data.id], "the same key pays once");
	assert.equal((await call(tok.a, "GET", "/money")).data.balance_cents, start - 125);
	assert.equal((await call(tok.b, "GET", "/money")).data.balance_cents, start + 125);

	// what can't be paid
	const refused = async (body: object, status = 400) => assert.equal((await call(tok.a, "POST", "/money/send", { idempotency_key: `k-${tag}-${Math.random().toString(36).slice(2)}`, ...body })).status, status, JSON.stringify(body));
	await refused({ to: handle("b"), amount_cents: start * 10 });
	await refused({ to: handle("a"), amount_cents: 1 });
	await refused({ to: "nobody_here_x", amount_cents: 1 });
	await refused({ to: handle("b"), amount_cents: 0 });
	await refused({ to: handle("b"), amount_cents: 1.5 });
	await refused({ to: handle("b"), amount_cents: 1, idempotency_key: "short" });
	assert.equal((await call(tok.aRead, "POST", "/money/send", { to: handle("b"), amount_cents: 1, idempotency_key: `k-${tag}-r` })).status, 403, "a read token can't pay");
	await sql`insert into blocks(blocker_id, blocked_id) values(${people.c}::bigint, ${people.a}::bigint)`;
	await refused({ to: handle("c"), amount_cents: 1 });
	await sql`delete from blocks where blocker_id = ${people.c}::bigint`;

	// a request of one account: it waits on them, they pay it
	const asked = await call(tok.b, "POST", "/money/requests", { from: handle("a"), amount_cents: 150, note: "tickets" });
	assert.equal(asked.status, 201);
	const waiting = await call(tok.a, "GET", "/money/requests");
	const mine = waiting.data.find((q: any) => q.id === asked.data.id);
	assert.deepEqual([mine?.can_pay, mine?.can_decline, mine?.can_cancel], [true, true, false]);
	assert.equal((await call(tok.a, "POST", "/money/send", { to: handle("b"), amount_cents: 100, idempotency_key: `k-${tag}-2`, request_id: asked.data.id })).status, 400, "a request is paid in full");
	assert.equal((await call(tok.a, "POST", "/money/send", { to: handle("b"), amount_cents: 150, idempotency_key: `k-${tag}-3`, request_id: asked.data.id })).status, 201);
	assert.equal((await call(tok.b, "GET", `/money/requests/${asked.data.id}`)).data.status, "paid");

	// declined and cancelled
	const toDecline = await call(tok.b, "POST", "/money/requests", { from: handle("a"), amount_cents: 99 });
	assert.equal((await call(tok.b, "POST", `/money/requests/${toDecline.data.id}/decline`)).status, 409, "only the payer declines");
	assert.equal((await call(tok.a, "POST", `/money/requests/${toDecline.data.id}/decline`)).data.status, "declined");
	const toCancel = await call(tok.b, "POST", "/money/requests", { from: handle("a"), amount_cents: 98 });
	assert.equal((await call(tok.b, "POST", `/money/requests/${toCancel.data.id}/cancel`)).data.status, "cancelled");
	assert.equal((await call(tok.b, "POST", "/money/requests", { from: handle("a") })).status, 400, "asking one account needs an amount");

	// a "Pay @you" card: anyone pays it, any amount
	const card = await call(tok.b, "POST", "/money/requests", { note: "tips" });
	assert.deepEqual([card.data.payer, card.data.amount_cents, card.data.can_cancel], [null, null, true]);
	assert.equal((await call(tok.c, "GET", `/money/requests/${card.data.id}`)).data.can_pay, true, "anyone can pay a card");
	assert.equal((await call(tok.c, "POST", "/money/send", { to: handle("b"), amount_cents: 42, idempotency_key: `k-${tag}-4`, request_id: card.data.id })).status, 201);
	assert.deepEqual([(await call(tok.b, "GET", `/money/requests/${card.data.id}`)).data.paid_count, (await call(tok.b, "GET", `/money/requests/${card.data.id}`)).data.status], [1, "open"], "a card stays open");

	// a payment is private to its two sides until one of them posts it
	assert.equal((await call(tok.c, "GET", `/money/payments/${sent.data.id}`)).status, 404);
	const post = newId();
	await sql`insert into posts(id, user_id, text, conversation_id) values(${post}::bigint, ${people.b}::bigint, ${`thanks! ${sent.data.url}`}, ${post}::bigint)`;
	const shown = await call(tok.c, "GET", `/money/payments/${sent.data.id}`);
	assert.deepEqual([shown.status, shown.data.direction], [200, null], "visible once posted, to someone on neither side");

	// activity: both directions, newest first, paged
	const act = await call(tok.b, "GET", "/money/activity?limit=2");
	assert.deepEqual(act.data.map((t: any) => t.direction), ["received", "received"]);
	assert(act.next_cursor, "more to come");
	const next = await call(tok.b, "GET", `/money/activity?limit=2&cursor=${act.next_cursor}`);
	assert.equal(next.data[0].id, sent.data.id, "the next page continues where the first stopped");
	assert(!("earnings" in next), "earnings come with the first page");

	// a like pays the post's author, once
	const liked = newId();
	await sql`insert into posts(id, user_id, text, conversation_id) values(${liked}::bigint, ${people.a}::bigint, 'worth a like', ${liked}::bigint)`;
	const before = (await call(tok.a, "GET", "/money")).data.balance_cents;
	await call(tok.c, "POST", `/posts/${liked}/like`);
	await call(tok.c, "DELETE", `/posts/${liked}/like`);
	await call(tok.c, "POST", `/posts/${liked}/like`);
	assert.equal((await call(tok.a, "GET", "/money")).data.balance_cents, before + settings().money.like_cents, "a like pays once");
	const earned = (await call(tok.a, "GET", "/money/activity")).earnings;
	assert.deepEqual([earned[0].likes, earned[0].cents], [1, settings().money.like_cents]);

	console.log("X Money API checks passed");
} finally {
	await setSetting("features", features);
	await sql`delete from users where id = any(${sql.array(Object.values(people), "INT8")})`;
	await sql.close();
}
