// Replies into a protected account's threads (GHSA-m9x2-9x93-6879): only people
// who may see the thread take part, also through a public reply inside it.
// Restores the accounts and removes what it posts.
// usage: bun scripts/test-protected-replies.ts <protected user> <follower> <stranger> <password>
import { sql } from "../src/db";

const origin = `http://localhost:${process.env.PORT ?? 3000}`;
const [ownerName, followerName, strangerName, password] = process.argv.slice(2);
if (!password) throw new Error("usage: bun scripts/test-protected-replies.ts <protected user> <follower> <stranger> <password>");

let failed = 0;
const check = (ok: boolean, label: string) => {
	if (!ok) failed++;
	console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
};

async function session(username: string) {
	const r = await fetch(`${origin}/login`, { method: "POST", body: new URLSearchParams({ username, password }), redirect: "manual" });
	const cookies = r.headers.getSetCookie().map((c) => c.split(";")[0]);
	const csrf = cookies.find((c) => c.startsWith("ct0="))?.slice(4);
	if (!csrf) throw new Error(`login ${username} failed`);
	const headers = { cookie: cookies.join("; "), "x-csrf-token": csrf, "content-type": "application/json" };
	return async (text: string, replyTo?: string) => {
		const body = { variables: { tweet_text: text, ...(replyTo ? { reply: { in_reply_to_tweet_id: replyTo } } : {}) } };
		const j: any = await (await fetch(`${origin}/i/api/graphql/x/CreateTweet`, { method: "POST", headers, body: JSON.stringify(body) })).json();
		return j.data?.create_tweet?.tweet_results?.result?.rest_id as string | undefined;
	};
}

const [owner] = await sql`select id::text, protected from users where lower(screen_name) = lower(${ownerName})`;
const [follower] = await sql`select id::text from users where lower(screen_name) = lower(${followerName})`;
const [stranger] = await sql`select id::text from users where lower(screen_name) = lower(${strangerName})`;
const follows = await sql`select follower_id::text, created_at from follows where followee_id = ${owner.id}::bigint
	and follower_id in (${follower.id}::bigint, ${stranger.id}::bigint)`;
const made: string[] = [];
const keep = (id: string | undefined) => (id && made.push(id), id);
try {
	await sql`update users set protected = true where id = ${owner.id}::bigint`;
	await sql`delete from follows where follower_id = ${stranger.id}::bigint and followee_id = ${owner.id}::bigint`;
	await sql`insert into follows (follower_id, followee_id) values (${follower.id}::bigint, ${owner.id}::bigint) on conflict do nothing`;
	const [asOwner, asFollower, asStranger] = [await session(ownerName), await session(followerName), await session(strangerName)];

	const root = keep(await asOwner("protected thread"));
	check(!!root, "protected account posts");
	check(!keep(await asStranger("reply", root)), "a stranger can't reply to the protected post");
	const ownReply = keep(await asOwner("more", root));
	check(!keep(await asStranger("reply", ownReply)), "nor to the owner's reply in it");
	const followerReply = keep(await asFollower("reply", root));
	check(!!followerReply, "an approved follower can reply");
	check(!keep(await asStranger("reply", followerReply)), "a stranger can't reply to the follower's public reply inside the thread");
	check(!!keep(await asFollower("again", followerReply)), "the follower can reply inside the thread");

	await sql`update users set protected = false where id = ${owner.id}::bigint`;
	const open = keep(await asOwner("public now"));
	check(!!keep(await asStranger("reply", open)), "anyone replies once the account is public");
} finally {
	if (made.length) await sql`delete from posts where id = any(${sql.array(made, "INT8")})`;
	await sql`update users set protected = ${owner.protected} where id = ${owner.id}::bigint`;
	await sql`delete from follows where followee_id = ${owner.id}::bigint and follower_id in (${follower.id}::bigint, ${stranger.id}::bigint)`;
	for (const f of follows) await sql`insert into follows (follower_id, followee_id, created_at) values (${f.follower_id}::bigint, ${owner.id}::bigint, ${f.created_at})`;
	await sql.close();
}
console.log(failed ? `${failed} failed` : "all passed");
if (failed) process.exit(1);
