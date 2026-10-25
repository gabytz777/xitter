// A suspended account disappears for everyone but staff: search, feeds,
// conversations, lists of people, reactions, recommendations, notifications.
// Its own profile shows "Account suspended", except to admins, who open it
// with a Suspended label. Run against the live server.
// usage: bun scripts/test-suspended.ts   (needs pozo as admin, password testpass123)
import { createUser } from "../src/auth";
import { sql } from "../src/db";

const origin = "http://localhost:3000", password = "testpass123";
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
	const get = async (op: string, variables: object) =>
		(await (await fetch(`${origin}/i/api/graphql/q/${op}?variables=${encodeURIComponent(JSON.stringify(variables))}`, { headers })).json()) as any;
	const rest = async (path: string) => (await (await fetch(origin + "/i/api" + path, { headers })).json()) as any;
	return { gql, get, rest };
}

const stamp = Date.now().toString().slice(-7);
const badName = "susp" + stamp, viewerName = "seer" + stamp;
const bad = await createUser(badName, "Zqx Suspendee", password);
const seer = await createUser(viewerName, "Plain Viewer", password);
const made = [bad, seer];
try {
	const b = await session(badName), v = await session(viewerName), admin = await session("pozo");
	const word = "zqxmarker" + stamp;
	const own = (await b.gql("CreateTweet", { tweet_text: `own post ${word} #${word}` })).data.create_tweet.tweet_results.result.rest_id;
	const root = (await v.gql("CreateTweet", { tweet_text: `viewer post ${stamp}` })).data.create_tweet.tweet_results.result.rest_id;
	await b.gql("CreateTweet", { tweet_text: `reply ${word}`, reply: { in_reply_to_tweet_id: root } });
	await b.gql("CreateTweet", { tweet_text: `quote ${word}`, attachment_url: `${origin}/x/status/${root}` });
	await b.gql("FavoriteTweet", { tweet_id: root });
	await b.gql("CreateRetweet", { tweet_id: root });
	await fetch(origin + "/i/api/1.1/friendships/create.json", { method: "POST", headers: { ...(await (async () => { const r = await fetch(origin + "/login", { method: "POST", body: new URLSearchParams({ username: badName, password }), redirect: "manual" }); const c = r.headers.getSetCookie().map((x) => x.split(";")[0]); return { cookie: c.join("; "), "x-csrf-token": c.find((x) => x.startsWith("ct0="))!.slice(4) }; })()) }, body: new URLSearchParams({ user_id: seer }) });
	await sql`update users set status = 'suspended', status_until = null where id = ${bad}::bigint`;

	const leaks = (r: unknown, ...needles: string[]) => needles.some((n) => JSON.stringify(r).includes(n));
	for (const [who, s, staff] of [["viewer", v, false], ["staff", admin, true]] as const) {
		const people = await s.get("SearchTimeline", { rawQuery: badName, product: "People", count: 20 });
		check(`${who}: people search hides it`, !leaks(people, `"screen_name":"${badName}"`));
		const top = await s.get("SearchTimeline", { rawQuery: word, product: "Top", count: 20 });
		check(`${who}: post search hides its posts`, !leaks(top, word));
		const typeahead = await s.rest(`/1.1/search/typeahead.json?q=${badName}&src=search_box&result_type=events,users,topics`);
		check(`${who}: typeahead hides it`, !leaks(typeahead, `"screen_name":"${badName}"`), typeahead);
		if (staff) {
			// an admin opens its profile, labelled, and its posts there; nowhere else
			const profile = (await s.get("UserByScreenName", { screen_name: badName })).data?.user?.result;
			check(`${who}: opens its profile, labelled Suspended`, profile?.__typename === "User" && profile.affiliates_highlighted_label?.label?.description === "Suspended", profile);
			check(`${who}: sees its posts on the profile`, leaks(await s.get("UserTweets", { userId: bad, count: 20 }), word));
			check(`${who}: Following still hides its posts`, !leaks(await s.get("HomeLatestTimeline", { count: 50 }), word));
			continue;
		}
		const all = await s.get("ListLatestTweetsTimeline", { listId: "1", count: 50 });
		check(`${who}: the All feed hides its posts`, !leaks(all, word));
		const home = await s.get("HomeLatestTimeline", { count: 50 });
		check(`${who}: Following hides its posts and reposts`, !leaks(home, word, `"screen_name":"${badName}"`));
		const thread = await s.get("TweetDetail", { focalTweetId: root });
		check(`${who}: its reply is gone from the conversation`, !leaks(thread, word));
		const opened = await s.get("TweetDetail", { focalTweetId: own });
		check(`${who}: its post can't be opened`, !leaks(opened, word), opened);
		const likers = await s.get("Favoriters", { tweetId: root, count: 20 });
		check(`${who}: likers hide it`, !leaks(likers, badName));
		const reposters = await s.get("Retweeters", { tweetId: root, count: 20 });
		check(`${who}: reposters hide it`, !leaks(reposters, badName));
		const followers = await s.get("Followers", { userId: seer, count: 20 });
		check(`${who}: followers lists hide it`, !leaks(followers, badName));
		const notes = await s.get("NotificationsTimeline", { timeline_type: "All", count: 40 });
		check(`${who}: notifications hide its follow, like, reply and repost`, !leaks(notes, badName, word));
		const recs = await s.get("SidebarUserRecommendations", { profileUserId: seer, limit: 20 });
		check(`${who}: who-to-follow hides it`, !leaks(recs, badName));
		const profile = await s.get("UserByScreenName", { screen_name: badName });
		check(`${who}: its profile says suspended`, profile.data?.user?.result?.__typename === "UserUnavailable", profile);
		const counts = (await s.get("TweetResultByRestId", { tweetId: root })).data?.tweetResult?.result;
		const legacy = counts?.legacy ?? counts?.tweet?.legacy;
		check(`${who}: like and repost counts don't count it`, legacy?.favorite_count === 0 && legacy?.retweet_count === 0, legacy && { likes: legacy.favorite_count, reposts: legacy.retweet_count });
	}
} finally {
	for (const id of made) await sql`delete from users where id = ${id}::bigint`;
	await sql.end();
}
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
