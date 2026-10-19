import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createUser } from "../src/auth";
import { sql } from "../src/db";
import { newId } from "../src/ids";

const origin = `http://localhost:${process.env.PORT ?? 3000}`;
const dir = process.env.MEDIA_DIR ?? "media";
const stamp = Date.now() % 1e7;
let failures = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : `: ${JSON.stringify(detail)}`}`);
}

const login = async (name: string) => {
	const r = await fetch(`${origin}/login`, { method: "POST", body: new URLSearchParams({ username: name, password: "testpass123" }), redirect: "manual" });
	return r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
};

const ids = await Promise.all(["pm", "pf", "ps"].map((p) => createUser(`${p}${stamp}`, p, "testpass123")));
const [owner, follower, stranger] = ids;
const media: string[] = [];
try {
	await sql`update users set protected = true where id = ${owner}::bigint`;
	await sql`insert into follows (follower_id, followee_id) values (${follower}::bigint, ${owner}::bigint)`;
	const post = newId();
	await sql`insert into posts (id, user_id, text, conversation_id) values (${post}::bigint, ${owner}::bigint, 'pic', ${post}::bigint)`;
	const openPost = newId();
	await sql`insert into posts (id, user_id, text, conversation_id) values (${openPost}::bigint, ${stranger}::bigint, 'pic', ${openPost}::bigint)`;
	mkdirSync(dir, { recursive: true });
	for (const [user, p] of [[owner, post], [stranger, openPost]]) {
		const id = newId();
		media.push(id);
		writeFileSync(join(dir, id), Buffer.from("GIF89a"));
		await sql`insert into media (id, user_id, kind, mime, size, width, height, post_id, position) values (${id}::bigint, ${user}::bigint, 'photo', 'image/gif', 6, 1, 1, ${p}::bigint, 0)`;
	}
	const [hidden, open] = media;
	const get = async (who: string, id: string) => fetch(`${origin}/media/${id}.gif`, { headers: { cookie: await login(who) } });

	const mine = await get(`pm${stamp}`, hidden);
	check("the owner gets it without persistent caching", mine.status === 200 && mine.headers.get("cache-control") === "private, no-store", mine.headers.get("cache-control"));
	const fan = await get(`pf${stamp}`, hidden);
	check("a follower gets it", fan.status === 200);
	check("a stranger doesn't", (await get(`ps${stamp}`, hidden)).status === 404);
	check("signed out doesn't", (await fetch(`${origin}/media/${hidden}.gif`)).status === 404);
	const pub = await get(`pf${stamp}`, open);
	// A public upload can become protected or be deleted at the same URL.
	check("public media also avoids persistent or shared caching", pub.status === 200 && pub.headers.get("cache-control") === "private, no-store", pub.headers.get("cache-control"));
	await sql`delete from posts where id = ${openPost}::bigint`;
	check("a deleted post's media is immediately gone for others", (await get(`pf${stamp}`, open)).status === 404);
	check("but its owner still gets it", (await get(`ps${stamp}`, open)).status === 200);
} finally {
	for (const id of media) rmSync(join(dir, id), { force: true });
	await sql`delete from users where id = any(${sql.array(ids, "INT8")})`;
}
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
