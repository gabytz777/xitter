// Circles (circles.ts): a Circle post shows only to its author and the people
// in their Circle, with X's Circle label; replies stay in the Circle; it
// can't be reposted or quoted, and it never federates. Staff see it where they
// go looking (the post, the profile, search), not in their own timeline or
// notifications. Run against the live server.
// usage: bun scripts/test-circles.ts   (TEST_ORIGIN, else http://localhost:3000)
import { createUser } from "../src/auth";
import { sql } from "../src/db";

const origin = process.env.TEST_ORIGIN ?? "http://localhost:3000", password = "testpass123";
let failures = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
	console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : ` ${JSON.stringify(detail).slice(0, 300)}`}`);
	if (!ok) failures++;
}
async function session(username: string) {
	const r = await fetch(origin + "/login", { method: "POST", body: new URLSearchParams({ username, password }), redirect: "manual" });
	const cookies = r.headers.getSetCookie().map((c) => c.split(";")[0]);
	const headers = { cookie: cookies.join("; "), "x-csrf-token": cookies.find((c) => c.startsWith("ct0="))!.slice(4) };
	const gql = async (op: string, variables: object) =>
		(await (await fetch(`${origin}/i/api/graphql/q/${op}`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ variables }) })).json()) as any;
	const page = async (path: string, form?: Record<string, string>) =>
		(await fetch(origin + path, form ? { method: "POST", headers: { cookie: headers.cookie }, body: new URLSearchParams(form) } : { headers: { cookie: headers.cookie } })).text();
	return { gql, page };
}

const stamp = Date.now().toString().slice(-7);
const word = `circleword${stamp}`;
const ids = await Promise.all(["cown", "cin", "cout", "cstaff"].map((n) => createUser(n + stamp, n, password)));
try {
	await sql`update users set role = 'moderator' where id = ${ids[3]}::bigint`;
	const [owner, member, outsider, staff] = await Promise.all(["cown", "cin", "cout", "cstaff"].map((n) => session(n + stamp)));
	const csrf = /name="csrf" value="([^"]+)"/.exec(await owner.page("/account/circle"))![1];
	check("the Circle page adds a member", (await owner.page("/account/circle", { csrf, add: `@cin${stamp}` })).includes(`Added @cin${stamp}`));
	await sql`insert into follows (follower_id, followee_id) values (${ids[1]}::bigint, ${ids[0]}::bigint), (${ids[2]}::bigint, ${ids[0]}::bigint), (${ids[3]}::bigint, ${ids[0]}::bigint) on conflict do nothing`;

	const made = await owner.gql("CreateTweet", { tweet_text: `for the circle ${word} @cstaff${stamp}`, exclusive_tweet_control_options: {} });
	const id = made.data?.create_tweet?.tweet_results?.result?.rest_id;
	check("a Circle post is made", !!id, made);
	const label = (r: any) => (r?.tweet ?? r)?.trusted_friends_info_result?.owner_results?.result?.core?.screen_name;
	const read = async (s: Awaited<ReturnType<typeof session>>) => (await s.gql("TweetResultByRestId", { tweetId: id })).data?.tweetResult?.result;
	check("its author sees it, labelled", label(await read(owner)) === `cown${stamp}`, await read(owner));
	check("a member sees it, labelled", label(await read(member)) === `cown${stamp}`);
	check("anyone else gets nothing", !(await read(outsider)));
	const leaks = (r: unknown) => JSON.stringify(r).includes(word);
	check("Following shows it to a member", leaks(await member.gql("HomeLatestTimeline", { count: 40 })));
	check("Following hides it from anyone else", !leaks(await outsider.gql("HomeLatestTimeline", { count: 40 })));
	check("the profile hides it from anyone else", !leaks(await outsider.gql("UserTweets", { userId: ids[0], count: 40 })));
	check("search hides it from anyone else", !leaks(await outsider.gql("SearchTimeline", { rawQuery: word, product: "Latest", count: 20 })));
	check("staff see it, labelled", label(await read(staff)) === `cown${stamp}`, await read(staff));
	check("staff see it on the profile", leaks(await staff.gql("UserTweets", { userId: ids[0], count: 40 })));
	check("staff find it in search", leaks(await staff.gql("SearchTimeline", { rawQuery: word, product: "Latest", count: 20 })));
	check("staff's own Following leaves it out", !leaks(await staff.gql("HomeLatestTimeline", { count: 40 })));
	check("mentioned staff outside the Circle aren't notified", !leaks(await staff.gql("NotificationsTimeline", { timeline_type: "All", count: 40 })));

	const reply = await member.gql("CreateTweet", { tweet_text: `reply ${word}`, reply: { in_reply_to_tweet_id: id } });
	const replyId = reply.data?.create_tweet?.tweet_results?.result?.rest_id;
	check("a member replies", !!replyId, reply);
	const [r] = await sql`select circle_owner_id::text as owner from posts where id = ${replyId}::bigint`;
	check("the reply stays in the Circle", r?.owner === ids[0]);
	const outsiderReply = await outsider.gql("CreateTweet", { tweet_text: "let me in", reply: { in_reply_to_tweet_id: id } });
	check("anyone else can't reply", !outsiderReply.data?.create_tweet, outsiderReply);
	const repost = await member.gql("CreateRetweet", { tweet_id: id });
	check("it can't be reposted", !!repost.errors?.length && !repost.data?.create_retweet, repost);
	const quote = await member.gql("CreateTweet", { tweet_text: "quoting", attachment_url: `${origin}/cown${stamp}/status/${id}` });
	check("it can't be quoted", !quote.data?.create_tweet, quote);

	const [marked] = await sql`select 1 from posts p where p.id = ${id}::bigint and p.circle_owner_id = ${ids[0]}::bigint`;
	check("it is kept as a Circle post (federation-sync.ts publicPost leaves those out)", !!marked);
	const embed = await fetch(`${origin}/cown${stamp}/status/${id}`, { headers: { "user-agent": "Twitterbot/1.0" } }).then((x) => x.text());
	check("link previews leave it out", !embed.includes(word));

	await owner.page("/account/circle", { csrf, remove: ids[1] });
	check("removing a member", !(await owner.page("/account/circle")).includes(`@cin${stamp}`));
	check("a removed member no longer sees it", !(await read(member)));
} finally {
	for (const id of ids) await sql`delete from users where id = ${id}::bigint`;
	await sql.end();
}
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
