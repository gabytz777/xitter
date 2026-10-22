import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { conversationCard, conversationCardEntity } from "../src/conversation-cards";

const client = join(process.env.CLIENT_DIR ?? "client", "abs/responsive-web/client-web");
const files = await readdir(client).catch(() => []);
const bundle = files.find((name) => name.startsWith("shared~bundle.Birdwatch~bundle.Compose~bundle.Display"));
const nativeTest = bundle ? test : test.skip;

async function converters() {
	const text = await readFile(join(client, bundle!), "utf8");
	const start = text.indexOf("[n.sl.PROMO_IMAGE_CONVO]");
	const end = text.indexOf("[n.sl.", text.indexOf("[n.sl.PROMO_VIDEO_CONVO]", start) + 5);
	const types = new Proxy({}, { get: (_, key) => key });
	const value = (data: any, type: string, keys: string | string[]) => (Array.isArray(keys) ? keys : [keys]).map((key) => data[key]?.[type]).find((entry) => entry !== undefined);
	const check = (data: any, key: string, passed = true): any => ({ passed: passed && !!data[key], and: (next: string) => check(data, next, passed && !!data[key]) });
	const helpers = { Jn: value, Pj: value, j1: value, BS: (image: any) => image, F0: (url: string) => url, _g: (data: any, predicate: any) => predicate((key: string) => check(data, key)).passed };
	return new Function("n", "o", "s", "a", `return ({${text.slice(start, end)}})`)(
		{ sl: types, eu: types, qr: types, e: types, v1: types }, helpers,
		{ $: { getMediaDetailsLink: (url: string) => url, renderTweetActionLabel: (text: string) => text } },
		{ y6: { COMPOSE: "compose" }, A: types },
	);
}

nativeTest("pinned client's own image converter accepts and renders four conversation choices", async () => {
	const native = await converters();
	const config = conversationCard({ title: "Pick your side", thanksUrl: "https://example.com/thanks", thanksDisplayUrl: "example.com", choices: Array.from({ length: 4 }, (_, i) => ({ hashtag: `Choice${i}`, text: `Vote ${i}` })) });
	const card = conversationCardEntity(config, "123", { kind: "photo", url: "https://local.test/1.jpg", width: 1200, height: 628 });
	const data = Object.fromEntries(card.legacy.binding_values.map(({ key, value }) => [key, value]));
	const renderer = native.PROMO_IMAGE_CONVO;
	const converted = renderer.conversionHandler({ cardId: card.legacy.url, cardType: card.legacy.name, data, converterOptions: { tweetPermalink: "/alice/status/123" } });
	expect(renderer.shouldRenderCard(data)).toBe(true);
	expect(converted.card.components_data.DETAILS.data.title.content).toBe("Pick your side");
	expect(converted.card.components_data.BUTTON_GROUP.data.buttons).toHaveLength(4);
	expect(converted.card.components_data.BUTTON_GROUP.data.buttons[3].data.tweet).toBe("Vote 3 #Choice3");
	expect(converted.card.components_data.DETAILS_SECONDARY.data.title.content).toBe("Thanks for joining!");
	expect(converted.card.media_entities.IMAGE_ENTITY.url).toBe("https://local.test/1.jpg");
	expect(converted.card.destinations.DESTINATION_SECONDARY.data.url_data).toEqual({ url: "https://example.com/thanks", vanity: "example.com" });
	expect(converted.card.components_data.DETAILS_SECONDARY.data.destination).toBe("DESTINATION_SECONDARY");
});

nativeTest("pinned client's own video converter produces its native video player and compose button", async () => {
	const native = await converters();
	const config = conversationCard({ thanksUrl: "https://example.com/video", choices: [{ hashtag: "Cats", text: "Go cats" }] });
	const card = conversationCardEntity(config, "123", { kind: "video", url: "https://local.test/1.mp4", poster: "https://local.test/poster.jpg", stream: "https://local.test/media/card-video/1.xml", width: 1280, height: 720, duration: 2500 });
	const data = Object.fromEntries(card.legacy.binding_values.map(({ key, value }) => [key, value]));
	const renderer = native.PROMO_VIDEO_CONVO;
	const converted = renderer.conversionHandler({ cardId: card.legacy.url, cardType: card.legacy.name, data, converterOptions: { tweetPermalink: "/alice/status/123", tweetUserId: "456" } });
	expect(renderer.shouldRenderCard(data)).toBe(true);
	expect(converted.card.components_data.MEDIA.data.id).toBe("VIDEO_ENTITY_SECONDARY");
	expect(converted.card.media_entities.VIDEO_ENTITY_SECONDARY.vmap_url).toBe("https://local.test/media/card-video/1.xml");
	expect(converted.card.media_entities.VIDEO_ENTITY_SECONDARY.aspect_ratio).toBe(1280 / 720);
	expect(converted.card.components_data.BUTTON_GROUP.data.buttons[0].data.tweet).toBe("Go cats #Cats");
	expect(converted.card.destinations.DESTINATION_SECONDARY.data.url_data.url).toBe("https://example.com/video");
});
