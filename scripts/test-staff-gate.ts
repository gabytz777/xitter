import { createUser } from "../src/auth";
import { sql } from "../src/db";
import { newId } from "../src/ids";

const origin = `http://localhost:${process.env.PORT ?? 3000}`;
const stamp = Date.now() % 1e7;
let failures = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : `: ${JSON.stringify(detail)}`}`);
}

async function session(name: string) {
	const r = await fetch(`${origin}/login`, { method: "POST", body: new URLSearchParams({ username: name, password: "testpass123" }), redirect: "manual" });
	const cookies = r.headers.getSetCookie().map((c) => c.split(";")[0]);
	const csrf = cookies.find((c) => c.startsWith("ct0="))?.slice(4) ?? "";
	const headers = { cookie: cookies.join("; "), "x-csrf-token": csrf };
	return {
		sees: async (post: string) =>
			JSON.stringify(await (await fetch(`${origin}/i/api/graphql/q/TweetDetail?variables=${encodeURIComponent(JSON.stringify({ focalTweetId: post }))}`, { headers })).json()).includes(`"rest_id":"${post}"`),
		security: (body: object) => fetch(`${origin}/admin/api/saveSecurity`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) }),
	};
}

const names = ["sgo", "sgs", "sgt", "sgp"].map((p) => `${p}${stamp}`);
const ids = await Promise.all(names.map((n) => createUser(n, n, "testpass123")));
const [owner, staffer, trusted, member] = ids;
const restore = { staff_2fa: false, admin_ips: [] as string[] };
let admin: Awaited<ReturnType<typeof session>> | undefined;
try {
	await sql`update users set protected = true where id = ${owner}::bigint`;
	await sql`update users set role = 'admin' where id = any(${sql.array([staffer, trusted], "INT8")})`;
	const post = newId();
	await sql`insert into posts (id, user_id, text, conversation_id) values (${post}::bigint, ${owner}::bigint, 'only followers', ${post}::bigint)`;
	const [s, t, m] = await Promise.all([names[1], names[2], names[3]].map(session));
	admin = t;
	await sql`update users set totp_enabled = true where id = ${trusted}::bigint`;

	check("a member can't see a protected post", !(await m.sees(post)));
	check("staff can while the panel is open to them", await s.sees(post));
	const saved = await t.security({ staff_2fa: true, admin_ips: [] });
	check("an admin with two-factor requires it of staff", saved.ok, saved.ok ? "" : await saved.text());
	check("staff without two-factor lose the staff view", !(await s.sees(post)));
	check("staff with two-factor keep it", await t.sees(post));
} finally {
	await admin?.security(restore);
	await sql`delete from audit_log where actor_id = any(${sql.array(ids, "INT8")})`;
	await sql`delete from users where id = any(${sql.array(ids, "INT8")})`;
}
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
