import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { createUser } from "../src/auth";
import { sql } from "../src/db";

const origin = process.env.TEST_ORIGIN ?? `http://localhost:${process.env.PORT ?? 3000}`;
const imagePath = process.argv[2];
const name = `cc${String(Date.now()).slice(-10)}`;
const password = crypto.randomUUID();
let userId: string | undefined, cookie: string, headers: Record<string, string>, response: Response, payload: any, photo: string, created: any, fresh: any, shared: any, stored: any, mediaRows: any[] = [];

async function gql(operation: string, variables: unknown) {
	const response = await fetch(`${origin}/graphql/test/${operation}`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ variables }) });
	const payload = await response.json();
	assert.equal(response.status, 200, JSON.stringify(payload));
	return payload;
}

async function upload(): Promise<string> {
	const bytes = await Bun.file(imagePath).bytes();
	const form = new FormData();
	const type = imagePath.endsWith(".png") ? "image/png" : "image/jpeg";
	let response: Response, payload: any, id: string;
	response = await fetch(`${origin}/i/media/upload.json?command=INIT&total_bytes=${bytes.length}&media_type=${type}&media_category=tweet_image`, { method: "POST", headers });
	payload = await response.json();id = payload.media_id_string;
	assert.ok(id, JSON.stringify(payload));
	form.set("media", new Blob([bytes], { type }), "card");
	response = await fetch(`${origin}/i/media/upload.json?command=APPEND&media_id=${id}&segment_index=0`, { method: "POST", headers, body: form });
	assert.equal(response.status, 204);
	response = await fetch(`${origin}/i/media/upload.json?command=FINALIZE&media_id=${id}`, { method: "POST", headers });
	payload = await response.json();
	assert.equal(payload.media_id_string, id, JSON.stringify(payload));
	return id;
}

if (!imagePath) throw new Error("usage: bun scripts/test-conversation-live.ts <PNG or JPEG>");
try {
	userId = await createUser(name, "Conversation test", password);
	response = await fetch(`${origin}/login`, { method: "POST", body: new URLSearchParams({ username: name, password }), redirect: "manual" });
	cookie = response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
	headers = { cookie, "x-csrf-token": /(?:^|;\s*)ct0=([^;]+)/.exec(cookie)![1] };
	response = await fetch(`${origin}/i/api/1.1/graphql/app_context.json`, { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: "log=%7B%7D" });
	assert.equal(response.status, 204, "Client error reports must not produce a misleading CSRF error.");
	response = await fetch(`${origin}/graphql/test/CreateTweet`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ variables: { tweet_text: "Must fail CSRF" } }) });
	assert.equal(response.status, 403);
	assert.equal((await response.json()).errors[0].code, 353, "Posting must still require CSRF.");
	payload = await gql("CreateTweet", { tweet_text: "Missing media", xitter_conversation_card: { choices: [{ hashtag: "Cats" }] } });
	assert.equal(payload.errors[0].code, 214);
	photo = await upload();
	payload = await gql("CreateTweet", { tweet_text: "", media: { media_entities: [{ media_id: photo }] }, xitter_conversation_card: { choices: [{ hashtag: "two words" }] } });
	assert.equal(payload.errors[0].code, 214);
	assert.match(payload.errors[0].message, /Use a hashtag/);
	payload = await gql("CreateTweet", { tweet_text: "", media: { media_entities: [{ media_id: photo }] }, xitter_conversation_card: { title: "a".repeat(24), choices: [{ hashtag: "Cats" }] } });
	assert.equal(payload.errors[0].code, 214);
	assert.match(payload.errors[0].message, /23 characters/);

	payload = await gql("CreateTweet", { tweet_text: "", media: { media_entities: [{ media_id: photo }] }, xitter_conversation_card: { title: "Choose your side", thanks: "Thanks for joining!", thanksUrl: "https://example.com/thanks", thanksDisplayUrl: "example.com", choices: Array.from({ length: 4 }, (_, index) => ({ hashtag: `Choice${index}` })) } });
	assert.ok(!payload.errors, JSON.stringify(payload.errors));
	created = payload.data.create_tweet.tweet_results.result;
	assert.equal(created.card.legacy.name, "promo_image_convo");
	assert.equal(created.legacy.full_text, "");
	assert.equal(created.card.legacy.binding_values.find((entry: any) => entry.key === "cta_four_tweet").value.string_value, "#Choice3");
	[stored] = await sql`select jsonb_typeof(conversation_card) as type, conversation_card from posts where id = ${created.rest_id}::bigint`;
	assert.equal(stored.type, "object", "Bun must store the card as a JSON object, not a double-encoded string.");
	assert.equal(stored.conversation_card.choices.length, 4);
	assert.equal(stored.conversation_card.title, "Choose your side");
	assert.equal(stored.conversation_card.thanksUrl, "https://example.com/thanks");
	payload = await gql("TweetResultByRestId", { tweetId: created.rest_id });fresh = payload.data.tweetResult.result;
	assert.equal(fresh.card.legacy.name, "promo_image_convo");
	assert.equal(fresh.xitter_conversation_card.choices.length, 4);
	response = await fetch(`${origin}/v2/capi/passthrough/1?twitter%3Astring%3Acard_uri=${encodeURIComponent(created.card.legacy.url)}`, { headers });
	assert.equal(response.headers.get("content-type")?.includes("application/json"), true, "Native card reads must reach the API, not the app shell.");
	payload = await response.json();
	assert.equal(payload.card.binding_values.cta_four.string_value, "#Choice3");
	assert.equal(payload.card.binding_values.thank_you_url.string_value, "https://example.com/thanks");
	assert.equal(payload.card.binding_values.thank_you_vanity_url.string_value, "example.com");
	payload = await gql("CreateTweet", { tweet_text: "#Choice3", card_uri: created.card.legacy.url });
	assert.ok(!payload.errors, JSON.stringify(payload.errors));
	shared = payload.data.create_tweet.tweet_results.result;
	assert.equal(shared.card.legacy.url, created.card.legacy.url);
	assert.equal(shared.card.legacy.binding_values.find((entry: any) => entry.key === "thank_you_url").value.string_value, "https://example.com/thanks");
	payload = await gql("TweetResultByRestId", { tweetId: shared.rest_id });
	assert.equal(payload.data.tweetResult.result.card.legacy.url, created.card.legacy.url);
	console.log("Passed: telemetry, CSRF enforcement, media validation, upload, four-choice publication, JSON storage, fresh reads, native preview and sharing.");
} finally {
	if (userId) {
		mediaRows = await sql`select id::text from media where user_id = ${userId}::bigint`;
		await sql`delete from users where id = ${userId}::bigint`;
		await Promise.all(mediaRows.map((row: any) => rm(join(process.env.MEDIA_DIR ?? "media", row.id), { force: true })));
	}
	await sql.close();
}
