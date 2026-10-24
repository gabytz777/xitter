// End-to-end check of lists against a running server: create, members,
// timeline, subscribe, privacy, pinning, delete. Removes what it creates.
// usage: bun scripts/test-lists.ts <user A> <user B> <password of both>

import { sql } from "../src/db";
import { newId } from "../src/ids";

export {};

const origin = `http://localhost:${process.env.PORT ?? 3000}`;
const [nameA, nameB, password] = process.argv.slice(2);
if (!nameA || !nameB || !password) throw new Error("usage: bun scripts/test-lists.ts <user A> <user B> <password>");

// The built-in All list needs an instance admin; the CI database has none.
const adminTag = Date.now().toString(36);
await sql`insert into users (id, screen_name, name, password_hash, role) values (${newId()}::bigint, ${`${adminTag}admin`}, 'List admin fixture', 'x', 'admin')`;

async function session(username: string) {
	const r = await fetch(`${origin}/login`, { method: "POST", body: new URLSearchParams({ username, password }), redirect: "manual" });
	const cookies = r.headers.getSetCookie().map((c) => c.split(";")[0]);
	const csrf = cookies.find((c) => c.startsWith("ct0="))?.slice(4);
	if (!csrf) throw new Error(`login ${username} failed`);
	const headers = { cookie: cookies.join("; "), "x-csrf-token": csrf };
	const gql = async (op: string, variables: object) =>
		(await fetch(`${origin}/i/api/graphql/q/${op}`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ variables }) })).json();
	const get = async (op: string, variables: object) =>
		(await fetch(`${origin}/i/api/graphql/q/${op}?variables=${encodeURIComponent(JSON.stringify(variables))}`, { headers })).json();
	return { gql, get };
}

let failures = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : `: ${JSON.stringify(detail)}`}`);
}

const entriesOf = (timeline: any): any[] => (timeline?.instructions ?? []).flatMap((i: any) => i.entries ?? []);
const listsIn = (timeline: any) => entriesOf(timeline).flatMap((e) => (e.content?.itemContent?.list ? [e.content.itemContent.list] : []));

const a = await session(nameA);
const b = await session(nameB);
const userA = (await a.get("UserByScreenName", { screen_name: nameA })).data.user.result;
const userB = (await a.get("UserByScreenName", { screen_name: nameB })).data.user.result;
const made: string[] = [];

const created = await a.gql("CreateList", { name: "Test list", description: "for the test", isPrivate: false });
const list = created.data?.list;
check("create returns the list", list?.name === "Test list" && list.mode === "Public" && list.member_count === 0, list && { id: list.id_str, mode: list.mode });
const id = list?.id_str as string;
if (id) made.push(id);

const tooLong = await a.gql("CreateList", { name: "x".repeat(40), description: "", isPrivate: false });
check("a name over 25 characters is refused", !!tooLong.errors?.length);

const added = await a.gql("ListAddMember", { listId: id, userId: userB.rest_id });
check("add member", added.data?.list?.member_count === 1);
const again = await a.gql("ListAddMember", { listId: id, userId: userB.rest_id });
check("adding twice keeps one", again.data?.list?.member_count === 1);
const strangers = await b.gql("ListAddMember", { listId: id, userId: userA.rest_id });
check("only the owner adds members", !!strangers.errors?.length);

const post = (await b.gql("CreateTweet", { tweet_text: "a post for the list timeline" })).data.create_tweet.tweet_results.result.rest_id;
const other = (await a.gql("CreateTweet", { tweet_text: "own post, not on the list" })).data.create_tweet.tweet_results.result.rest_id;
const tl = entriesOf((await a.get("ListLatestTweetsTimeline", { listId: id, count: 20 })).data.list.tweets_timeline.timeline);
const tweetIds = tl.map((e) => e.content?.itemContent?.tweet_results?.result?.rest_id).filter(Boolean);
check("list timeline has the member's post", tweetIds.includes(post), tweetIds);
check("list timeline hides non-members", !tweetIds.includes(other));

const members = entriesOf((await a.get("ListMembers", { listId: id, count: 20 })).data.list.members_timeline.timeline);
check("members list", members.some((e) => e.content?.itemContent?.user_results?.result?.rest_id === userB.rest_id));

// more members than the first page; the cursor has to fetch the rest
const pageTag = Date.now().toString(36);
const pageIds = Array.from({ length: 201 }, () => newId());
for (const [i, userId] of pageIds.entries()) {
	await sql`insert into users (id, screen_name, name, password_hash) values (${userId}::bigint, ${`lp${pageTag}${i}`}, ${`Page ${i}`}, 'x')`;
	await sql`insert into list_members (list_id, user_id) values (${id}::bigint, ${userId}::bigint)`;
}
const memberIds = (entries: any[]) => entries.flatMap((e) => (e.content?.itemContent?.user_results?.result?.rest_id ? [e.content.itemContent.user_results.result.rest_id] : []));
const first = entriesOf((await a.get("ListMembers", { listId: id, count: 20 })).data.list.members_timeline.timeline);
const firstIds = memberIds(first);
const bottom = first.find((e) => e.content?.cursorType === "Bottom")?.content?.value;
const second = bottom ? entriesOf((await a.get("ListMembers", { listId: id, count: 20, cursor: bottom })).data.list.members_timeline.timeline) : [];
const secondIds = memberIds(second);
const paged = new Set([...firstIds, ...secondIds]);
check("members page past the first 200", firstIds.length === 200 && secondIds.length >= 2 && pageIds.every((u) => paged.has(u)), { first: firstIds.length, second: secondIds.length, bottom });
await sql`delete from users where screen_name like ${`lp${pageTag}%`}`;

const owned = await a.get("ListOwnerships", { userId: userA.rest_id, isListMemberTargetUserId: userB.rest_id, count: 100 });
const ownedList = listsIn(owned.data.user.result.timeline.timeline).find((l) => l.id_str === id);
check("ownerships report membership of the target", ownedList?.is_member === true);

const bySlug = await a.get("ListBySlug", { screenName: nameA, listSlug: "test-list" });
check("by slug", bySlug.data?.user_by_screen_name?.list?.id_str === id);

// B subscribes, sees it, unsubscribes
const sub = await b.gql("ListSubscribe", { listId: id });
check("subscribe", sub.data?.list_subscribe_v3?.following === true && sub.data.list_subscribe_v3.subscriber_count === 1);
const mgmt = await b.get("ListsManagementPageTimeline", { count: 100 });
check("management page lists the subscription", listsIn(mgmt.data.viewer.list_management_timeline.timeline).some((l) => l.id_str === id));
const disc = await b.get("ListsDiscovery", { count: 20 });
check("discovery excludes subscribed lists", !listsIn(disc.data.list_discovery_list_mixer_timeline.timeline).some((l) => l.id_str === id));
const unsub = await b.gql("ListUnsubscribe", { listId: id });
check("unsubscribe", unsub.data?.list?.following === false);

// pinning
const pin = await a.gql("PinTimeline", { pinnedTimelineItem: { id, pinned_timeline_type: "List" } });
check("pin", pin.data?.pin_timeline?.updated_pinned_timeline?.list?.pinning === true, pin.data?.pin_timeline?.__typename);
const pinned = await a.get("PinnedTimelines", {});
check("pinned timelines", pinned.data.pinned_timelines.pinned_timelines.some((p: any) => p.list?.id_str === id));
await a.gql("UnpinTimeline", { pinnedTimelineItem: { id, pinned_timeline_type: "List" } });
check("unpin", !(await a.get("PinnedTimelines", {})).data.pinned_timelines.pinned_timelines.some((p: any) => p.list?.id_str === id));

// the built-in "All" list: every post, first home tab, fixed, can be unpinned
const ALL = "1";
check("All is the first home tab", (await a.get("PinnedTimelines", {})).data.pinned_timelines.pinned_timelines[0]?.list?.id_str === ALL);
const everything = JSON.stringify(entriesOf((await a.get("ListLatestTweetsTimeline", { listId: ALL, count: 100 })).data.list.tweets_timeline.timeline));
check("All has posts from members and non-members", everything.includes(post) && everything.includes(other));
check("All can't take members", !!(await a.gql("ListAddMember", { listId: ALL, userId: userB.rest_id })).errors?.length);
check("All can't be subscribed", !!(await b.gql("ListSubscribe", { listId: ALL })).errors?.length);
await a.gql("UnpinTimeline", { pinnedTimelineItem: { id: ALL, pinned_timeline_type: "List" } });
check("All can be unpinned", !(await a.get("PinnedTimelines", {})).data.pinned_timelines.pinned_timelines.some((p: any) => p.list?.id_str === ALL));
await a.gql("PinTimeline", { pinnedTimelineItem: { id: ALL, pinned_timeline_type: "List" } });
check("and pinned back", (await a.get("PinnedTimelines", {})).data.pinned_timelines.pinned_timelines[0]?.list?.id_str === ALL);
check("/all opens it", (await fetch(`${origin}/all`, { redirect: "manual" })).headers.get("location") === "/i/lists/1");

// privacy
const edited = await a.gql("UpdateList", { listId: id, name: "Renamed", description: "", isPrivate: true });
check("update to private", edited.data?.list?.mode === "Private" && edited.data.list.name === "Renamed");
const hidden = await b.get("ListByRestId", { listId: id });
check("a private list is invisible to others", !!hidden.errors?.length && !hidden.data?.list, hidden.errors?.[0]?.message);
const subPrivate = await b.gql("ListSubscribe", { listId: id });
check("can't subscribe to a private list", !!subPrivate.errors?.length);

const removed = await a.gql("ListRemoveMember", { listId: id, userId: userB.rest_id });
check("remove member", removed.data?.list?.member_count === 0);

const deleted = await a.gql("DeleteList", { listId: id });
check("delete", deleted.data?.list_delete === "Done");
made.pop();
const gone = await a.get("ListByRestId", { listId: id });
check("deleted list is gone", !!gone.errors?.length);

for (const p of [post]) await b.gql("DeleteTweet", { tweet_id: p });
await a.gql("DeleteTweet", { tweet_id: other });
for (const m of made) await a.gql("DeleteList", { listId: m });
await sql`delete from users where screen_name = ${`${adminTag}admin`}`;

console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
