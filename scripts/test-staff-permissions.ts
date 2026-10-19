// What an admin lets moderators and support do (staff-permissions.ts), against
// a running server: bun scripts/test-staff-permissions.ts
import { createUser } from "../src/auth";
import { sql } from "../src/db";

const origin = "http://localhost:3000";
const password = "testpass123";
let checks = 0;
const check = (ok: unknown, label: string) => {
	if (!ok) throw new Error(label);
	checks++;
	console.log("ok  ", label);
};
async function staff(username: string) {
	const r = await fetch(`${origin}/login`, { method: "POST", body: new URLSearchParams({ username, password }), redirect: "manual" });
	const cookies = r.headers.getSetCookie().map((c) => c.split(";")[0]);
	const csrf = cookies.find((c) => c.startsWith("ct0="))?.slice(4) ?? "";
	return async (action: string, body: Record<string, unknown> = {}) => {
		const res = await fetch(`${origin}/admin/api/${action}`, { method: "POST", headers: { cookie: cookies.join("; "), "x-csrf-token": csrf, "content-type": "application/json" }, body: JSON.stringify(body) });
		return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
	};
}
const stamp = Date.now().toString(36);
const created: string[] = [];
const make = async (p: string, role: string | null) => {
	const name = `${p}${stamp}`;
	const id = await createUser(name, name, password);
	created.push(id);
	if (role) await sql`update users set role = ${role} where id = ${id}::bigint`;
	return { id, name };
};
// the server keeps settings in memory, so what was there goes back through the panel too
let restore = async () => {};
try {
	const a = await make("pa_", "admin");
	const m = await make("pm_", "moderator");
	const s = await make("ps_", "support");
	const u = await make("pu_", null);
	const asA = await staff(a.name);
	const asM = await staff(m.name);
	const asS = await staff(s.name);
	const { roles } = (await asA("staffPermissions")).body;
	restore = async () => {
		for (const role of ["moderator", "support"]) await asA("saveStaffPermissions", { role, permissions: roles[role] });
	};
	for (const role of ["moderator", "support"]) await asA("saveStaffPermissions", { role, permissions: {} });

	check((await asM("setStatus", { id: u.id, status: "restricted" })).status === 200, "a moderator changes standing by default");
	check((await asM("deleteUser", { id: u.id, confirm: u.name })).status === 403, "but can't delete accounts by default");
	check((await asS("setStatus", { id: u.id, status: "active" })).status === 403, "support can't change standing by default");
	check((await asM("resetPassword", { id: u.id })).status === 403 && (await asS("resetPassword", { id: u.id })).status === 403, "nor can moderators or support reset passwords");
	await asA("createInvite", {});
	await asA("sendTestMail", { to: `${u.name}@example.org` });
	const invites = (await asS("invites")).body.invites, mail = (await asM("mail")).body.log;
	check(invites.length && invites.every((i: any) => i.code === null), "support sees no invite codes");
	check((await asS("user", { id: u.id })).body.alts === null && (await asM("user", { id: u.id })).body.alts !== null, "nor accounts seen at the same address, which moderators do");
	check(mail.length && mail.every((l: any) => l.to_addr === null) && (await asA("mail")).body.log.some((l: any) => l.to_addr), "staff below admin see no email addresses");
	check((await asM("errors")).status === 403 && (await asA("errors")).status === 200, "server errors are for admins");
	check((await asM("staffPermissions")).status === 403, "only admins see the permissions");
	check((await asM("saveStaffPermissions", { role: "moderator", permissions: { delete_accounts: true } })).status === 403, "and only admins change them");

	const list = await asA("staffPermissions");
	check(list.body.roles.moderator.standing === true && list.body.roles.support.standing === false && list.body.roles.support.sessions === true, "the defaults follow the roles");
	check((await asA("saveStaffPermissions", { role: "moderator", permissions: { standing: false, delete_posts: true, profiles: true, orgs: true } })).status === 200, "an admin changes what moderators can do");
	check((await asA("saveStaffPermissions", { role: "support", permissions: { standing: true, passwords: true, sessions: false, invites: true, emails: true, ip_addresses: true } })).status === 200, "and what support can do");
	check((await asA("saveStaffPermissions", { role: "admin", permissions: {} })).status === 400, "admins' own permissions aren't for choosing");
	check((await asA("saveStaffPermissions", { role: "moderator", permissions: { set_role: true } })).status === 400, "an unknown permission is refused");

	check((await asM("setStatus", { id: u.id, status: "active" })).status === 403, "the moderator can't change standing any more");
	check((await asM("updateUser", { id: u.id, bio: "edited by a moderator" })).status === 200, "but edits profiles now");
	const org = await make("po_", null);
	await sql`update users set verified_type = 'business' where id = ${org.id}::bigint`;
	check((await asM("addAffiliate", { orgId: org.id, screen_name: u.name })).status === 200, "and adds affiliates");
	check((await asM("addAffiliate", { orgId: org.id, screen_name: a.name })).status === 403, "but not an admin");
	check((await asM("removeAffiliate", { orgId: org.id, userId: u.id })).status === 200, "and removes them");
	check((await asS("setStatus", { id: u.id, status: "active" })).status === 200, "support changes standing now");
	check((await asS("resetPassword", { id: u.id })).status === 200, "and resets passwords once given them");
	check((await asS("resetPassword", { id: a.id })).status === 403 && (await asS("resetPassword", { id: m.id })).status === 403, "but never an admin's or a moderator's");
	check((await asS("signOut", { id: u.id })).status === 403, "and can't sign accounts out any more");
	check((await asS("user", { id: u.id })).body.alts !== null && (await asS("invites")).body.invites.every((i: any) => i.code) && (await asS("mail")).body.log.some((l: any) => l.to_addr), "and sees addresses and codes once given them");
	check((await asS("setStatus", { id: m.id, status: "restricted" })).status === 403, "a permission doesn't reach staff at or above the role");
	check((await asM("setRole", { id: u.id, role: "moderator" })).status === 403, "roles stay with admins");

	const me = await asM("me");
	check(me.body.allowed.includes("updateUser") && !me.body.allowed.includes("setStatus") && !me.body.allowed.includes("setRole"), "the panel is told what the moderator may do");
	const [log] = await sql`select detail from audit_log where actor_id = ${a.id}::bigint and action = 'set_staff_permissions' and detail->>'role' = 'moderator' order by id desc limit 1`;
	check(log?.detail.revoked.includes("standing") && log.detail.granted.includes("profiles"), "the change is in the audit log");

	await asA("saveStaffPermissions", { role: "moderator", permissions: {} });
	check((await asM("setStatus", { id: u.id, status: "active" })).status === 200, "back to the defaults gives standing back");
	check((await asM("updateUser", { id: u.id, bio: "again" })).status === 403, "and takes profiles away");
	console.log(`all passed (${checks})`);
} finally {
	await restore();
	for (const id of created) {
		await sql`delete from audit_log where target = ${id} or actor_id = ${id}::bigint`;
		await sql`delete from invites where created_by = ${id}::bigint`;
		await sql`delete from mail_log where user_id = ${id}::bigint`;
		await sql`delete from users where id = ${id}::bigint`;
	}
	await sql.end();
}
