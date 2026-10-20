// End-to-end check of Settings > Your account against a running server: password
// change, password check, username change and availability, language,
// deactivation and coming back. Makes its own account and removes it.
// usage: bun scripts/test-account-settings.ts

import { sql } from "../src/db";
import { createUser } from "../src/auth";

const origin = `http://localhost:${process.env.PORT ?? 3000}`;
const name = `s${Date.now() % 1e8}`;
const other = `${name}x`;
let failures = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : `: ${JSON.stringify(detail)}`}`);
}

async function signIn(username: string, password: string) {
	const r = await fetch(`${origin}/login`, { method: "POST", body: new URLSearchParams({ username, password }), redirect: "manual" });
	const cookies = r.headers.getSetCookie().map((c) => c.split(";")[0]);
	const csrf = cookies.find((c) => c.startsWith("ct0="))?.slice(4);
	if (!csrf) return undefined;
	const headers = { cookie: cookies.join("; "), "x-csrf-token": csrf };
	const post = (path: string, body: Record<string, string>) =>
		fetch(`${origin}/i/api${path}`, { method: "POST", headers, body: new URLSearchParams(body) });
	return { headers, post };
}

const id = await createUser(name, "Settings Test", "testpass123");
await createUser(other, "Other", "testpass123");

try {
	let s = (await signIn(name, "testpass123"))!;
	const second = (await signIn(name, "testpass123"))!;

	check("a wrong current password is refused", (await s.post("/i/account/change_password.json", { current_password: "nope", new_password: "newpass456", password_confirmation: "newpass456" })).status === 403);
	check("a short new password is refused", (await s.post("/i/account/change_password.json", { current_password: "testpass123", new_password: "short", password_confirmation: "short" })).status === 400);
	check("mismatched confirmation is refused", (await s.post("/i/account/change_password.json", { current_password: "testpass123", new_password: "newpass456", password_confirmation: "different1" })).status === 400);
	check("password change works", (await s.post("/i/account/change_password.json", { current_password: "testpass123", password: "newpass456", password_confirmation: "newpass456" })).ok);
	check("the old password no longer signs in", !(await signIn(name, "testpass123")));
	check("the new one does", !!(await signIn(name, "newpass456")));
	const kept = await fetch(`${origin}/i/api/1.1/account/settings.json`, { headers: s.headers });
	check("this session stays signed in", kept.ok);
	const gone = await fetch(`${origin}/i/api/1.1/account/settings.json`, { headers: second.headers });
	check("other sessions are signed out", gone.status === 401 || gone.status === 403 || gone.status === 404, gone.status);

	check("verify_password accepts the right one", (await s.post("/1.1/account/verify_password.json", { password: "newpass456" })).ok);
	check("and refuses a wrong one", (await s.post("/1.1/account/verify_password.json", { password: "nope" })).status === 403);

	check("a taken username is refused", (await s.post("/1.1/account/settings.json", { screen_name: other })).status === 400);
	check("an invalid username is refused", (await s.post("/1.1/account/settings.json", { screen_name: "no spaces" })).status === 400);
	const renamed = `${name}n`;
	const changed = await s.post("/1.1/account/settings.json", { screen_name: renamed });
	check("a free username is taken", changed.ok && (await changed.json()).screen_name === renamed);
	const [row] = await sql`select screen_name from users where id = ${id}::bigint`;
	check("and stored, with the change recorded", row.screen_name === renamed && (await sql`select 1 from username_changes where user_id = ${id}::bigint`).length === 1);

	const lang = await s.post("/1.1/account/settings.json", { lang: "ru" });
	check("language is stored", (await lang.json()).language === "ru");

	check("deactivation needs the password", (await s.post("/1.1/account/deactivate.json", { current_password: "nope" })).status === 403);
	check("deactivation works", (await s.post("/1.1/account/deactivate.json", { current_password: "newpass456" })).ok);
	check("a deactivated account is signed out", (await fetch(`${origin}/i/api/1.1/account/settings.json`, { headers: s.headers })).status !== 200);
	s = (await signIn(renamed, "newpass456"))!;
	check("signing in again brings it back", !!s);
	const [back] = await sql`select status, deactivated_at from users where id = ${id}::bigint`;
	check("active again", back.status === "active" && back.deactivated_at === null, back);
} finally {
	await sql`delete from users where screen_name in (${name}, ${other}, ${`${name}n`})`;
}
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
