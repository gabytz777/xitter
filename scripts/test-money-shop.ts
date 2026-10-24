// The shop (money-shop.ts, money-admin.ts) against a migrated, disposable
// local database: who may list and deliver what, the money held and refunded
// around a request, gifts, the paid announcement and taking it down, and the
// federation outbox giving up on a peer that never answers.
import { strict as assert } from "node:assert";
import { AdminError } from "../src/admin";
import { sql } from "../src/db";
import { newId } from "../src/ids";
import { moneyActions } from "../src/money-admin";
import { pumpOnce } from "../src/money-federation";
import { ShopError, buyShopItem, shopItems } from "../src/money-shop";
import { balanceOf } from "../src/money";
import { loadSettings, setSetting, settings } from "../src/settings";

const database = new URL(process.env.DATABASE_URL ?? "postgres://localhost/xitter");
assert(["localhost", "127.0.0.1"].includes(database.hostname) && /test|codex/.test(database.pathname), "Use a disposable local test database.");

await loadSettings();
const before = { features: settings().features, money: settings().money, money_shop: settings().money_shop };
const tag = newId().slice(-8);
const people = { admin: newId(), mod: newId(), buyer: newId(), friend: newId() };
const handle = (k: keyof typeof people) => `xs${k[0]}${tag}`;
const actor = (k: keyof typeof people, role: string | null) => ({ id: people[k], role, screen_name: handle(k) }) as any;
const admin = actor("admin", "admin"), mod = actor("mod", "moderator");
const run = (action: string, who: any, body: Record<string, unknown> = {}) => moneyActions[action].run(who, body as any);
const refused = async (p: Promise<unknown>, type: any, status?: number) => {
	try {
		await p;
		assert.fail("expected a refusal");
	} catch (e) {
		assert(e instanceof type, `expected ${type.name}, got ${e}`);
		if (status) assert.equal((e as AdminError).status, status);
	}
};
const badgeId = newId();
const items: string[] = [];

try {
	for (const k of Object.keys(people) as (keyof typeof people)[]) await sql`insert into users(id, screen_name, name, password_hash, role) values(${people[k]}::bigint, ${handle(k)}, ${k}, 'unused', ${k === "admin" ? "admin" : k === "mod" ? "moderator" : null})`;
	await sql`insert into custom_badges (id, name, image, mime) values (${badgeId}::bigint, ${`shop badge ${tag}`}, ${Buffer.from("not a real image")}, 'image/png')`;
	await setSetting("features", { ...before.features, money: true });
	await setSetting("money_shop", { enabled: true, announcement: null });

	// a peer's word is all there is for what it sends: the daily cap is on by default
	assert.equal(settings().money.peer_daily_cents, 100_000, "the per-peer daily cap defaults to one largest payment");

	// listings: an admin's goes up at once, a moderator's waits for an admin
	const listed = async (who: any, body: Record<string, unknown>) => {
		const r = (await run("createShopItem", who, body)) as { id: string; approved: boolean };
		items.push(r.id);
		return r;
	};
	const byMod = await listed(mod, { name: "Mod badge", price: "2", kind: "badge", badgeId });
	assert.equal(byMod.approved, false);
	const badgeItem = await listed(admin, { name: "Badge", price: "2", kind: "badge", badgeId });
	assert.equal(badgeItem.approved, true);
	assert.equal((await shopItems(true)).some((i: any) => i.id === byMod.id), false, "a pending listing isn't for sale");
	await run("reviewShopItem", admin, { id: byMod.id, approve: true });
	assert.equal((await shopItems(true)).some((i: any) => i.id === byMod.id), true);
	const announcementItem = await listed(admin, { name: "Say something", price: "1", kind: "announcement" });
	const checkmarkItem = await listed(admin, { name: "Blue", price: "1", kind: "checkmark" });
	const dearItem = await listed(admin, { name: "Dear", price: "100000", kind: "badge", badgeId });

	// buying holds the money; a second request for the same item waits for the first
	const start = await balanceOf(people.buyer);
	const order = await buyShopItem(people.buyer, badgeItem.id, {});
	assert.equal(await balanceOf(people.buyer), start - 200);
	await refused(buyShopItem(people.buyer, badgeItem.id, {}), ShopError);
	await refused(buyShopItem(people.buyer, dearItem.id, {}), ShopError);
	assert.equal(await balanceOf(people.buyer), start - 200, "a refused request costs nothing");

	// a moderator refunds and delivers badges
	await run("reviewShopOrder", mod, { id: order.id, approve: false });
	assert.equal(await balanceOf(people.buyer), start, "a rejection refunds");
	await refused(run("reviewShopOrder", mod, { id: order.id, approve: true }), AdminError);
	const again = await buyShopItem(people.buyer, badgeItem.id, {});
	await run("reviewShopOrder", mod, { id: again.id, approve: true });
	assert.equal((await sql`select 1 from user_badges where user_id = ${people.buyer}::bigint and badge_id = ${badgeId}::bigint`).length, 1, "approved: the badge is on");
	assert.equal(await balanceOf(people.buyer), start - 200);
	await refused(buyShopItem(people.buyer, badgeItem.id, {}), ShopError);

	// a gift goes to the recipient; the buyer pays
	const gift = await buyShopItem(people.buyer, badgeItem.id, { gift: handle("friend") });
	await run("reviewShopOrder", mod, { id: gift.id, approve: true });
	assert.equal((await sql`select 1 from user_badges where user_id = ${people.friend}::bigint and badge_id = ${badgeId}::bigint`).length, 1, "the friend has the gift");
	assert.equal(await balanceOf(people.buyer), start - 400);
	assert.equal(await balanceOf(people.friend), settings().money.starting_cents, "the recipient paid nothing");

	// anything beyond a badge is an admin's to deliver; a moderator can still refund it
	const blue = await buyShopItem(people.buyer, checkmarkItem.id, {});
	await refused(run("reviewShopOrder", mod, { id: blue.id, approve: true }), AdminError, 403);
	await run("reviewShopOrder", mod, { id: blue.id, approve: false });
	assert.equal(await balanceOf(people.buyer), start - 400);
	const said = await buyShopItem(people.buyer, announcementItem.id, { text: `hello from ${tag}`, link: "https://example.com/x" });
	await refused(run("reviewShopOrder", mod, { id: said.id, approve: true }), AdminError, 403);
	await run("reviewShopOrder", admin, { id: said.id, approve: true });
	assert.equal(settings().money_shop.announcement?.text, `hello from ${tag}`);
	assert.deepEqual(settings().money_shop.announcement?.buttons, [{ label: "Learn more", url: "https://example.com/x" }]);

	// and comes down again
	await run("clearShopAnnouncement", admin);
	assert.equal(settings().money_shop.announcement, null);
	await refused(run("clearShopAnnouncement", admin), AdminError);

	// a transfer a peer never takes goes back to the sender after three days, a fresh one keeps trying
	const stale = newId(), fresh = newId();
	await sql`update money_wallets set balance_cents = 1000 where user_id = ${people.buyer}::bigint`;
	const held = await balanceOf(people.buyer);
	await sql`update money_wallets set balance_cents = balance_cents - 70 where user_id = ${people.buyer}::bigint`;
	for (const [id, age] of [[stale, "4 days"], [fresh, "1 minute"]] as const) {
		await sql`insert into money_transfers (id, sender_id, recipient_id, amount_cents, note, idem, federation_status)
			values (${id}::bigint, ${people.buyer}::bigint, ${people.friend}::bigint, 35, '', ${`t-${id}`}, 'pending')`;
		await sql`insert into money_federation_outbox (transfer_id, destination, sender_id, recipient_id, amount_cents, created_at)
			values (${id}::bigint, 'peer.invalid', ${people.buyer}::bigint, 1, 35, now() - ${age}::interval)`;
	}
	await pumpOnce();
	const status = async (id: string) => (await sql`select federation_status from money_transfers where id = ${id}::bigint`)[0].federation_status;
	assert.equal(await status(stale), "failed", "the stale transfer gave up");
	assert.equal(await status(fresh), "pending", "the fresh one is still trying");
	assert.equal((await sql`select attempts from money_federation_outbox where transfer_id = ${fresh}::bigint`)[0]?.attempts, 1);
	assert.equal(await balanceOf(people.buyer), held - 35, "only the stale one was refunded");

	console.log("Shop checks passed");
} finally {
	await setSetting("features", before.features);
	await setSetting("money_shop", before.money_shop);
	await sql`delete from users where id = any(${sql.array(Object.values(people), "INT8")})`;
	if (items.length) await sql`delete from money_shop_items where id = any(${sql.array(items, "INT8")})`;
	await sql`delete from custom_badges where id = ${badgeId}::bigint`;
	await sql.close();
}
