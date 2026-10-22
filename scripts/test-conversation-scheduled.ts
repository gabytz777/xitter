import assert from "node:assert/strict";
import type { Viewer } from "../src/auth";
import { sql } from "../src/db";
import { newId } from "../src/ids";
import { FEDERATION_ON } from "../src/federation";
import { runOperation } from "../src/graphql";
import { getPost, PostError } from "../src/posts";
import { runDue, scheduledHandlers as handlers } from "../src/scheduled";

const database = new URL(process.env.DATABASE_URL ?? "postgres://localhost/xitter");
const owner = newId(), stranger = newId();
const viewer = { id: owner } as Viewer;
const at = Math.floor(Date.now() / 1000) + 3600;
const card = { title: "Choose your side", thanks: "Thanks for joining!", thanksUrl: "https://example.com/thanks", thanksDisplayUrl: "example.com", choices: [{ hashtag: "Cats", text: "Go cats" }, { hashtag: "Dogs", text: "Go dogs" }] };
const trigger = `card_schedule_failure_${owner.slice(-10)}`;
let triggerCreated = false, draft: string, scheduled: string, photo: string, replyPhoto: string, failedPhoto: string, failed: string, listed: any, published: any, response: any, body: any, request: any, rows: any[], field: string, moderationOwner: string;
const moderationOwners: string[] = [];

assert(["localhost", "127.0.0.1"].includes(database.hostname) && /test|codex/.test(database.pathname), "Use a disposable local test database.");

async function upload(userId = owner) {
	const id = newId();
	await sql`insert into media (id, user_id, kind, mime, size, width, height, state) values (${id}::bigint, ${userId}::bigint, 'photo', 'image/png', 10, 1200, 628, 'ready')`;
	return id;
}

async function queue(post: any) {
	return (await handlers.CreateScheduledTweet(viewer, { execute_at: at, post_tweet_request: post })).data.tweet.rest_id;
}

async function due(id: string, attempts = 0) {
	await sql`update scheduled_posts set execute_at = now() - interval '1 second', attempts = ${attempts} where id = ${id}::bigint`;
}

async function stored(id: string) {
	return (await sql`select kind, request, last_error from scheduled_posts where id = ${id}::bigint`)[0];
}

async function denied(action: () => Promise<unknown>, code: number) {
	await assert.rejects(action, (error: unknown) => error instanceof PostError && error.code === code);
}

try {
	await sql`insert into users (id, screen_name, name, password_hash) values (${owner}::bigint, ${`cc${owner}`}, 'Card scheduler fixture', '!'), (${stranger}::bigint, ${`cc${stranger}`}, 'Other account', '!')`;
	draft = (await handlers.CreateDraftTweet(viewer, { post_tweet_request: { status: "", xitter_conversation_card: { title: "Work in progress", choices: [{ hashtag: "" }] } } })).data.tweet.rest_id;
	listed = (await handlers.FetchDraftTweets(viewer)).data.viewer.draft_list.response_data.find((item: any) => item.rest_id === draft);
	assert.equal(listed.tweet_create_request.xitter_conversation_card.title, "Work in progress");
	assert.equal(listed.tweet_create_request.xitter_conversation_card.choices[0].hashtag, "");
	assert.equal(listed.media_entities, undefined);
	photo = await upload();
	request = { status: "", media_ids: [photo], xitter_conversation_card: card };
	await handlers.EditDraftTweet(viewer, { draft_tweet_id: draft, post_tweet_request: request });
	listed = (await handlers.FetchDraftTweets(viewer)).data.viewer.draft_list.response_data.find((item: any) => item.rest_id === draft);
	assert.equal(listed.tweet_create_request.xitter_conversation_card.choices[1].hashtag, "#Dogs");
	assert.equal(listed.tweet_create_request.xitter_conversation_card.thanksUrl, card.thanksUrl);
	assert.equal(listed.media_entities[0].media_key.split("_")[1], photo);
	assert.equal((await handlers.FetchDraftTweets({ id: stranger } as Viewer)).data.viewer.draft_list.response_data.length, 0);
	await denied(() => handlers.EditDraftTweet({ id: stranger } as Viewer, { draft_tweet_id: draft, post_tweet_request: request }), 144);
	await handlers.EditDraftTweet(viewer, { draft_tweet_id: draft, post_tweet_request: { status: "Ordinary draft", media_ids: [photo] } });
	assert.equal((await stored(draft)).request.xitter_conversation_card, undefined);
	console.log("Passed: incomplete drafts, editing/removing card settings, media restoration and account isolation.");

	await denied(() => queue({ status: "Missing media", xitter_conversation_card: card }), 214);
	await denied(() => queue({ status: "", media_ids: [photo], xitter_conversation_card: { choices: [{ hashtag: "" }] } }), 214);
	await denied(async () => queue({ status: "", media_ids: [await upload(stranger)], xitter_conversation_card: card }), 214);
	scheduled = await queue(request);
	listed = (await handlers.FetchScheduledTweets(viewer)).data.viewer.scheduled_tweet_list.find((item: any) => item.rest_id === scheduled);
	assert.equal(listed.tweet_create_request.xitter_conversation_card.title, card.title);
	assert.equal(new Date(listed.scheduling_info.execute_at).getTime(), at * 1000);
	await handlers.EditScheduledTweet(viewer, { scheduled_tweet_id: scheduled, execute_at: at + 3600, post_tweet_request: { ...request, xitter_conversation_card: { ...card, thanks: "See you soon!" } } });
	listed = (await handlers.FetchScheduledTweets(viewer)).data.viewer.scheduled_tweet_list.find((item: any) => item.rest_id === scheduled);
	assert.equal(new Date(listed.scheduling_info.execute_at).getTime(), (at + 3600) * 1000);
	await due(scheduled);
	assert.equal(await runDue(), 1);
	rows = await sql`select id::text from posts where user_id = ${owner}::bigint and conversation_card is not null`;
	assert.equal(rows.length, 1);
	published = await getPost(owner, rows[0].id);
	assert.equal(published.conversationCard.thanks, "See you soon!");
	assert.equal(published.media[0].id, photo);
	assert.equal(await stored(scheduled), undefined);
	response = await runOperation("CreateTweet", viewer, { tweet_text: "", card_uri: `card://${published.id}` });
	body = await response.json();
	assert.equal(body.errors, undefined, JSON.stringify(body.errors));
	assert.equal(body.data.create_tweet.tweet_results.result.legacy.full_text, FEDERATION_ON ? "Choose your side #Cats #Dogs" : "");
	console.log("Passed: scheduled card editing/publication and useful text for empty federated card shares.");

	replyPhoto = await upload();
	scheduled = await queue({ status: "Card thread root", thread_tweets: [{ status: "", media_ids: [replyPhoto], xitter_conversation_card: card }] });
	await due(scheduled);
	assert.equal(await runDue(), 1);
	rows = await sql`select id::text, reply_to_id::text, conversation_card from posts where user_id = ${owner}::bigint and (text = 'Card thread root' or id = (select post_id from media where id = ${replyPhoto}::bigint)) order by id`;
	assert.equal(rows.length, 2);
	assert.equal(rows[1].reply_to_id, rows[0].id);
	assert.equal(rows[1].conversation_card.title, card.title);

	failedPhoto = await upload();
	failed = await queue({ status: "Atomic card", media_ids: [failedPhoto], xitter_conversation_card: card });
	await sql.unsafe(`create function ${trigger}() returns trigger language plpgsql as $$ begin if new.user_id = ${owner} and new.text = 'Atomic card' then raise exception 'forced card metadata failure'; end if; return new; end $$`);
	await sql.unsafe(`create trigger ${trigger} before update of conversation_card on posts for each row execute function ${trigger}()`);
	triggerCreated = true;
	await due(failed, 5);
	await runDue();
	assert.equal((await stored(failed)).kind, "draft");
	assert.equal((await stored(failed)).request.xitter_conversation_card.title, card.title);
	assert.equal((await sql`select id from posts where user_id = ${owner}::bigint and text = 'Atomic card'`).length, 0);
	assert.equal((await sql`select post_id from media where id = ${failedPhoto}::bigint`)[0].post_id, null);
	console.log("Passed: threaded cards and rollback of posts/media when card metadata fails, preserving a recoverable draft.");

	for (field of ["title", "thanks", "text"]) {
		moderationOwner = newId();moderationOwners.push(moderationOwner);
		await sql`insert into users (id, screen_name, name, password_hash) values (${moderationOwner}::bigint, ${`cc${moderationOwner}`}, 'Card moderation fixture', '!')`;
		request = { ...card, choices: card.choices.map((choice) => ({ ...choice })) };
		if (field === "text") request.choices[0].text = "kill all trans people";else request[field] = "kill all trans people";
		response = await runOperation("CreateTweet", { id: moderationOwner } as Viewer, { tweet_text: "", xitter_conversation_card: request });
		body = await response.json();
		assert.match(body.errors[0].message, /slur or hate speech/);
		assert((await sql`select id from audit_log where target = ${moderationOwner} and action in ('automod_second_chance', 'automod_strike')`).length > 0);
		assert.equal((await sql`select id from posts where user_id = ${moderationOwner}::bigint`).length, 0);
	}
	moderationOwner = newId();moderationOwners.push(moderationOwner);
	await sql`insert into users (id, screen_name, name, password_hash) values (${moderationOwner}::bigint, ${`cc${moderationOwner}`}, 'Card draft moderation fixture', '!')`;
	await denied(() => handlers.CreateDraftTweet({ id: moderationOwner } as Viewer, { post_tweet_request: { status: "", xitter_conversation_card: { ...card, title: "kill all trans people" } } }), 186);
	assert((await sql`select id from audit_log where target = ${moderationOwner} and action in ('automod_second_chance', 'automod_strike')`).length > 0);
	moderationOwner = newId();moderationOwners.push(moderationOwner);
	await sql`insert into users (id, screen_name, name, password_hash) values (${moderationOwner}::bigint, ${`cc${moderationOwner}`}, 'Card publication moderation fixture', '!')`;
	scheduled = (await handlers.CreateScheduledTweet({ id: moderationOwner } as Viewer, { execute_at: at, post_tweet_request: { status: "", media_ids: [await upload(moderationOwner)], xitter_conversation_card: card } })).data.tweet.rest_id;
	await sql`update scheduled_posts set request = jsonb_set(request, '{xitter_conversation_card,title}', to_jsonb('kill all trans people'::text)) where id = ${scheduled}::bigint`;
	await due(scheduled);
	await runDue();
	assert.equal((await stored(scheduled)).kind, "draft");
	assert.equal((await sql`select id from posts where user_id = ${moderationOwner}::bigint`).length, 0);
	assert((await sql`select id from audit_log where target = ${moderationOwner} and action in ('automod_second_chance', 'automod_strike')`).length > 0);
	console.log("Passed: normal post hate-filter and committed automod actions for card fields, drafts and scheduled publication.");
} finally {
	if (triggerCreated) {
		await sql.unsafe(`drop trigger if exists ${trigger} on posts`);
		await sql.unsafe(`drop function if exists ${trigger}()`);
	}
	await sql`delete from users where id = any(${sql.array([owner, stranger, ...moderationOwners], "INT8")})`;
	await sql.close();
}
