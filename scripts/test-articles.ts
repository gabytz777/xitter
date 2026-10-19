// End-to-end check of articles against a running server, using the request
// shapes the editor sends: draft, title, body with formatting and an image,
// cover, publish, reading it back through posts, lists, unpublish and delete.
// usage: bun scripts/test-articles.ts <user A> <user B> <password of both> <image>
// KEEP=1 leaves the published article up, for looking at it in the client.

import { readFileSync } from "node:fs";

const origin = `http://localhost:${process.env.PORT ?? 3000}`;
const [nameA, nameB, password, imagePath] = process.argv.slice(2);
if (!nameA || !nameB || !password || !imagePath) throw new Error("usage: bun scripts/test-articles.ts <user A> <user B> <password> <image>");

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
	async function upload(path: string) {
		const data = readFileSync(path);
		const init = await (await fetch(`${origin}/i/media/upload.json?command=INIT&total_bytes=${data.length}&media_type=image/png&media_category=tweet_image`, { method: "POST", headers })).json();
		const form = new FormData();
		form.set("media", new Blob([data]));
		await fetch(`${origin}/i/media/upload.json?command=APPEND&media_id=${init.media_id_string}&segment_index=0`, { method: "POST", headers, body: form });
		await fetch(`${origin}/i/media/upload.json?command=FINALIZE&media_id=${init.media_id_string}`, { method: "POST", headers });
		return init.media_id_string as string;
	}
	const rest = async (path: string, form: Record<string, string>) =>
		(await fetch(`${origin}/i/api/1.1/${path}`, { method: "POST", headers, body: new URLSearchParams(form) })).json();
	return { gql, get, upload, rest };
}

let failures = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : `: ${JSON.stringify(detail)}`}`);
}

const a = await session(nameA);
const b = await session(nameB);
const userA = (await a.get("UserByScreenName", { screen_name: nameA })).data.user.result;
const userB = (await b.get("UserByScreenName", { screen_name: nameB })).data.user.result;

// what the editor sends when a draft is created: an empty document
const created = (await a.gql("ArticleEntityDraftCreate", { content_state: { blocks: [], entity_map: [] } })).data.articleentity_create_draft.article_entity_results.result;
const id = created.rest_id;
check("draft created", !!id && created.lifecycle_state?.lifecycle === "Draft");

const titled = (await a.gql("ArticleEntityUpdateTitle", { articleEntityId: id, title: "A test article" })).data.articleentity_update_title;
check("title saved", titled.title === "A test article");
check("a title over 100 characters is refused", !!(await a.gql("ArticleEntityUpdateTitle", { articleEntityId: id, title: "x".repeat(101) })).errors);

const image = await a.upload(imagePath);
const body = {
	blocks: [
		{ key: "h1", data: {}, text: "Section one", type: "header-two", entity_ranges: [], inline_style_ranges: [] },
		{ key: "p1", data: {}, text: "Some bold words here.", type: "unstyled", entity_ranges: [], inline_style_ranges: [{ length: 4, offset: 5, style: "Bold" }] },
		{ key: "l1", data: {}, text: "first point", type: "unordered-list-item", entity_ranges: [], inline_style_ranges: [] },
		{ key: "l2", data: {}, text: "second point", type: "unordered-list-item", entity_ranges: [], inline_style_ranges: [] },
		{ key: "m1", data: {}, text: " ", type: "atomic", entity_ranges: [{ key: 0, offset: 0, length: 1 }], inline_style_ranges: [] },
		{ key: "p2", data: {}, text: "The end.", type: "unstyled", entity_ranges: [], inline_style_ranges: [] },
	],
	entity_map: [{ key: "0", value: { data: { media_items: [{ local_media_id: 1, media_category: "DraftTweetImage", media_id: image }] }, type: "MEDIA", mutability: "Immutable" } }],
};
const saved = (await a.gql("ArticleEntityUpdateContent", { article_entity: id, content_state: body })).data.articleentity_update_content_state;
const content = saved.content_state;
check("body comes back in the editor's load format", content?.blocks?.length === 6 && content.blocks[1].inlineStyleRanges?.[0]?.style === "Bold" && Array.isArray(content.entityMap), content?.blocks?.[1]);
check("body image entity uses camelCase", content?.entityMap?.[0]?.value?.data?.mediaItems?.[0]?.mediaId === image, content?.entityMap?.[0]);
check("body image is listed in media_entities", saved.media_entities?.[0]?.media_id === image && saved.media_entities[0].media_info?.__typename === "ApiImage");
check("preview text comes from the body", saved.preview_text?.startsWith("Section one Some bold words"), saved.preview_text);

const cover = await a.upload(imagePath);
const covered = (await a.gql("ArticleEntityUpdateCoverMedia", { articleEntityId: id, coverMedia: { media_id: cover, media_category: "DraftTweetImage" } })).data.articleentity_update_cover_media;
check("cover saved", covered.cover_media?.media_id === cover && !!covered.cover_media.media_info?.original_img_url);

check("someone else cannot read the draft", !(await b.get("ArticleEntityResultByRestId", { articleEntityId: id })).data?.article_result_by_rest_id);
check("someone else cannot edit it", !!(await b.gql("ArticleEntityUpdateTitle", { articleEntityId: id, title: "mine now" })).errors);
const drafts = (await a.get("ArticleEntitiesSlice", { userId: userA.rest_id, lifecycle: "Draft" })).data.user.result.articles_article_mixer_slice.items;
check("draft is listed under Drafts", drafts.some((i: any) => i.article_entity_results.result.rest_id === id));

const published = (await a.gql("ArticleEntityPublish", { articleEntityId: id, tweetText: "read this", visibilitySetting: "Everyone" })).data.articleentity_publish.article_entity_results.result;
const postId = published.metadata?.tweet_results?.rest_id;
check("published, with the post that carries it", published.lifecycle_state?.lifecycle === "Published" && !!postId);

const viaPost = (await b.get("TweetResultByRestId", { tweetId: postId })).data.tweetResult.result;
const article = viaPost?.article?.article_results?.result;
check("the post carries the article for other users", article?.rest_id === id && article.title === "A test article" && viaPost.legacy.full_text === "read this");
check("the reader gets the body and its image", article?.content_state?.blocks?.length === 6 && article.media_entities?.length === 1);
const feed = (await b.get("HomeTimeline", { count: 20 })).data.home.home_timeline_urt.instructions.flatMap((i: any) => i.entries ?? []);
check("the article shows in the feed", feed.some((e: any) => e.content?.itemContent?.tweet_results?.result?.article?.article_results?.result?.rest_id === id));
const tab = (await b.get("UserArticlesTweets", { userId: userA.rest_id, count: 20 })).data.user.result.timeline.timeline.instructions.flatMap((i: any) => i.entries ?? []);
check("the profile's Articles tab lists it", tab.some((e: any) => e.content?.itemContent?.tweet_results?.result?.rest_id === postId));
check("the profile says it has articles", (await b.get("UserByScreenName", { screen_name: nameA })).data.user.result.user_seed_tweet_count > 0);
const redirect = (await b.get("ArticleRedirectScreenQuery", { articleEntityId: id })).data.article_result_by_rest_id.result;
check("/i/article/<id> resolves to the post", redirect?.metadata?.tweet_results?.rest_id === postId && redirect.metadata.author_results?.result?.core?.screen_name === nameA);
const listed = async () =>
	((await b.get("ArticleEntitiesSlice", { userId: userA.rest_id, lifecycle: "Published" })).data.user.result.articles_article_mixer_slice.items as any[]).some(
		(i) => i.article_entity_results.result.rest_id === id,
	);
check("others see the published article in the author's list", await listed());
await a.rest("blocks/create.json", { user_id: userB.rest_id });
check("an author who blocked you doesn't list theirs for you", !(await listed()));
await a.rest("blocks/destroy.json", { user_id: userB.rest_id });

if (process.env.KEEP) {
	console.log(`kept /${nameA}/article/${postId}`);
} else {
	const back = (await a.gql("ArticleEntityUnpublish", { articleEntityId: id })).data.articleentity_unpublish.article_entity_results.result;
	check("unpublished back to a draft", back.lifecycle_state?.lifecycle === "Draft");
	check("its post is gone", !(await b.get("TweetResultByRestId", { tweetId: postId })).data?.tweetResult);
	await a.gql("ArticleEntityDelete", { articleEntityId: id });
	check("deleted", !(await a.get("ArticleEntityResultByRestId", { articleEntityId: id })).data?.article_result_by_rest_id);
}

console.log(failures ? `${failures} check(s) failed` : "all checks passed");
process.exit(failures ? 1 : 0);
