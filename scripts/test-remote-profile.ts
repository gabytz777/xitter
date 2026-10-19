// GHSA-x6p9-ggjp-fq3p: an account from another instance can be moderated here
// (its copy suspended, limited, its posts removed) but not dressed up: badges,
// flags, labels and org badges belong to its home instance, like the profile.
// usage: bun scripts/test-remote-profile.ts <admin> <password>   (against a running server)
import { sql } from "../src/db";
import { newId } from "../src/ids";

const origin = `http://localhost:${process.env.PORT ?? 3000}`;
const [adminName, password] = process.argv.slice(2);
if (!password) throw new Error("usage: bun scripts/test-remote-profile.ts <admin> <password>");

let failed = 0;
const check = (ok: boolean, label: string) => {
	if (!ok) failed++;
	console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
};

const r = await fetch(`${origin}/login`, { method: "POST", body: new URLSearchParams({ username: adminName, password }), redirect: "manual" });
const cookies = r.headers.getSetCookie().map((c) => c.split(";")[0]);
const csrf = cookies.find((c) => c.startsWith("ct0="))?.slice(4);
if (!csrf) throw new Error(`login ${adminName} failed`);
const admin = (action: string, body: object) =>
	fetch(`${origin}/admin/api/${action}`, { method: "POST", headers: { cookie: cookies.join("; "), "x-csrf-token": csrf, "content-type": "application/json" }, body: JSON.stringify(body) });

const id = newId();
const instance = "remote.example";
await sql`insert into users (id, screen_name, name, password_hash, instance, remote_id) values (${id}::bigint, ${`ghost${id.slice(-6)}@${instance}`}, 'Ghost', '!', ${instance}, ${id}::bigint)`;
try {
	for (const [action, body] of [
		["setBadge", { id, verified_type: "blue" }],
		["setFlag", { id, flag: "trans" }],
		["setBadges", { id, badges: [] }],
		["setProfileLabel", { id, label: null }],
		["setOrgBadge", { id, badge: null }],
	] as const) {
		const res = await admin(action, body);
		check(res.status === 403, `${action} on a remote account is refused (${res.status})`);
	}
	const [u] = await sql`select verified_type, flag from users where id = ${id}::bigint`;
	check(!u.verified_type && !u.flag, "nothing changed on the account");
	const status = await admin("setStatus", { id, status: "limited" });
	check(status.status === 200, `moderating its copy still works (${status.status})`);
} finally {
	await sql`delete from users where id = ${id}::bigint`;
	await sql.close();
}
console.log(failed ? `${failed} failed` : "all passed");
if (failed) process.exit(1);
