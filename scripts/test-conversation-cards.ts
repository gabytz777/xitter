import { expect, test } from "bun:test";
import { parse as parseCSS } from "cssom";
import { parseHTML } from "linkedom";
import { conversationCard, conversationCardEntity, conversationPostText, conversationVideoMap } from "../src/conversation-cards";
import { CONVERSATION_CARD_SCRIPT, CONVERSATION_CARD_CSS } from "../src/conversation-card-ui";

const card = () => ({ title: "Pick a side", thanks: "Thanks for joining!", choices: [{ hashtag: "#TeamCats", text: "I'm on team cats!" }] });

function harness(options: { csrf?: string; cookie?: string } = {}) {
	const { document } = parseHTML('<html><body><div id="composer" role="dialog"><div contenteditable="true" data-testid="tweetTextarea_0">Join us</div><div data-testid="toolBar"><button type="button" data-testid="tweetButtonInline">Post</button><div data-testid="ScrollSnap-List"><div class="native-slot"><button type="button" class="native-emoji" aria-label="Add emoji" aria-haspopup="menu"><svg class="native-icon" viewBox="0 0 24 24"><path d="M0 0" /></svg></button></div></div></div></div><article data-testid="tweet"><a href="/alice/status/123"><time>1m</time></a><div role="group"><button data-testid="like">Like</button></div></article></body></html>');
	const requests: any[] = [], timers: (() => void)[] = [];
	const location = { origin: "https://local.test", pathname: "/compose/post" };
	const state = { response: {} as any, background: "rgb(255, 255, 255)", foreground: "rgb(15, 20, 25)", accent: "rgb(29, 155, 240)" };
	const window = { __XITTER__: options.csrf ? { csrf: options.csrf } : {}, fetch: async (input: any, init: any) => {
		const headers = new Headers(init?.headers ?? input.headers);
		requests.push({ url: typeof input === "string" ? input : input.url, body: init?.body, headers, method: init?.method ?? input.method, credentials: init?.credentials ?? input.credentials });
		return Response.json(state.response);
	} };
	const XHR = function(this: any) { this.listeners = {}; this.headers = {}; } as any;
	const flush = () => { while (timers.length) timers.shift()!(); };
	const run = new Function("window", "document", "XMLHttpRequest", "MutationObserver", "setTimeout", "Request", "location", "getComputedStyle", CONVERSATION_CARD_SCRIPT);
	const observer = function(this: any) { this.observe = () => {}; } as any;
	XHR.prototype.open = function(this: any, method: string, url: string) { this.url = url; };
	XHR.prototype.setRequestHeader = function(this: any, name: string, value: string) { const key = name.toLowerCase(); this.headers[key] = this.headers[key] ? this.headers[key] + ", " + value : value; };
	XHR.prototype.addEventListener = function(this: any, type: string, handler: () => void) { this.listeners[type] = handler; };
	XHR.prototype.send = function(this: any, body: string) {
		requests.push({ url: this.url, body, headers: new Headers(this.headers) });
		this.responseText = JSON.stringify(state.response);
		this.listeners.load?.();
	};
	document.cookie = options.cookie ?? "ct0=current-session-csrf";
	run(window, document, XHR, observer, (fn: () => void) => { timers.push(fn); return 1; }, Request, location, (node: any) => ({ backgroundColor: state.background, color: node.getAttribute?.("aria-label") === "Add emoji" || node.closest?.('[aria-label="Add emoji"]') ? state.accent : state.foreground }));
	flush();
	return { document, requests, window, XHR, state, flush, location };
}

function configure(h: ReturnType<typeof harness>) {
	const button = h.document.querySelector('[data-xitter-conversation]') as any;
	let inputs: any;
	button.click();
	inputs = h.document.querySelectorAll(".xc-fields>label input, .xc-choice input, .xc-choice textarea");
	inputs[0].value = "Pick a side";
	inputs[1].value = "Thanks for joining!";
	inputs[2].value = "TeamCats";
	inputs[3].value = "I'm on team cats!";
}

test("conversation card fields normalize and preserve Unicode hashtags", () => {
	const raw = card();
	raw.choices[0].hashtag = " #猫好き ";
	expect(conversationCard(raw).choices[0].hashtag).toBe("#猫好き");
	expect(conversationCard({ choices: raw.choices })).toEqual({ title: "", thanks: "", choices: [{ hashtag: "#猫好き", text: "I'm on team cats!" }] });
});

test("rejects malformed cards, empty choices, bad hashtags and duplicate options", () => {
	const invalid = [null, [], "card", {}, { choices: [] }, { choices: Array(5).fill(card().choices[0]) }, { choices: [null] }, { choices: [{ hashtag: "#123", text: "Hi" }] }, { choices: [{ hashtag: "#two words", text: "Hi" }] }, { choices: [{ hashtag: 123, text: "Hi" }] }, { choices: [card().choices[0], { hashtag: "#teamcats", text: "Other" }] }];
	let raw: unknown;
	for (raw of invalid) expect(() => conversationCard(raw)).toThrow();
});

test("enforces field limits and moderation while allowing titles with multiple choices", () => {
	const raw = card();
	let text: string;
	expect(() => conversationCard({ ...raw, title: "x".repeat(24) })).toThrow();
	expect(() => conversationCard({ ...raw, thanks: "x".repeat(24) })).toThrow();
	expect(() => conversationCard({ choices: [{ hashtag: "#" + "a".repeat(20), text: "Hi" }] })).toThrow();
	expect(() => conversationCard({ choices: [{ hashtag: "#a", text: "x".repeat(257) }] })).toThrow();
	expect(conversationCard({ ...raw, choices: [...raw.choices, { hashtag: "#Dogs", text: "Dogs" }] }).title).toBe(raw.title);
	for (text of [raw.title, raw.thanks, raw.choices[0].text, raw.choices[0].hashtag]) expect(() => conversationCard(raw, (value) => value === text)).toThrow();
	expect(conversationCard({ choices: Array.from({ length: 4 }, (_, i) => ({ hashtag: `#Choice${i}`, text: "Hello" })) }).choices).toHaveLength(4);
});

test("fetch and XHR attach card settings only to their own composer and keep failures editable", async () => {
	const h = harness();
	const xhr = new h.XHR();
	configure(h);
	await h.window.fetch("/i/api/graphql/id/CreateTweet", { body: JSON.stringify({ variables: { tweet_text: "Another post" } }) });
	expect(JSON.parse(h.requests[0].body).variables.xitter_conversation_card).toBeUndefined();
	await h.window.fetch("/i/api/graphql/id/CreateTweet", { body: JSON.stringify({ variables: { tweet_text: "Join us" } }) });
	expect(JSON.parse(h.requests[1].body).variables.xitter_conversation_card).toEqual(card());
	xhr.open("POST", "/i/api/graphql/id/CreateTweet");
	xhr.send(JSON.stringify({ variables: { tweet_text: "Join us" } }));
	expect(JSON.parse(h.requests[2].body).variables.xitter_conversation_card).toEqual(card());
	expect(h.document.querySelector('[aria-label="Conversation card settings"]')).not.toBeNull();
});

test("image cards use the native conversation bindings and include all four choices", () => {
	const config = conversationCard({ thanks: "Thank you", choices: Array.from({ length: 4 }, (_, i) => ({ hashtag: `Choice${i}`, text: `Choose ${i}` })) });
	const result = conversationCardEntity(config, "123", { kind: "photo", url: "https://local.test/media/1.jpg", width: 1200, height: 628 });
	const bindings = Object.fromEntries(result.legacy.binding_values.map(({ key, value }) => [key, value])) as any;
	expect(result.legacy.name).toBe("promo_image_convo");
	expect(result.legacy.url).toBe("card://123");
	expect(bindings.promo_image.image_value).toEqual({ url: "https://local.test/media/1.jpg", width: 1200, height: 628 });
	expect(bindings.cta_four.string_value).toBe("#Choice3");
	expect(bindings.cta_four_tweet.string_value).toBe("Choose 3 #Choice3");
	expect(bindings.thank_you_text.string_value).toBe("Thank you");
});

test("video cards expose the native poster, stream map and dimensions", () => {
	const result = conversationCardEntity(card(), "123", { kind: "video", url: "https://local.test/media/1.mp4", poster: "https://local.test/media/poster/1.jpg", stream: "https://local.test/media/card-video/1.xml", width: 1280, height: 720, duration: 2500 });
	const bindings = Object.fromEntries(result.legacy.binding_values.map(({ key, value }) => [key, value])) as any;
	expect(result.legacy.name).toBe("promo_video_convo");
	expect(bindings.player_image_original.image_value.url).toContain("/poster/1.jpg");
	expect(bindings.player_stream_url.string_value).toContain("/card-video/1.xml");
	expect(bindings.player_width.string_value).toBe("1280");
	expect(bindings.content_duration_seconds.string_value).toBe("2.5");
	expect(conversationVideoMap("1", "https://local.test/1.mp4?a=1&b=2")).toContain("a=1&amp;b=2");
	expect(conversationVideoMap("1", "https://local.test/1.mp4")).toContain("http://twitter.com/schema/videoVMapV2.xsd");
});

test("scheduling preserves card settings and successful publication removes the editor", async () => {
	const h = harness();
	configure(h);
	await h.window.fetch("/i/api/graphql/id/CreateScheduledTweet", { body: JSON.stringify({ variables: { post_tweet_request: { status: "Join us" } } }) });
	expect(JSON.parse(h.requests[0].body).variables.post_tweet_request.xitter_conversation_card).toEqual(card());
	h.state.response = { data: { create_tweet: { tweet_results: { result: { rest_id: "123", xitter_conversation_card: card() } } } } };
	await h.window.fetch("/i/api/graphql/id/CreateTweet", { body: JSON.stringify({ variables: { tweet_text: "Join us" } }) });
	await Bun.sleep(5);
	expect(h.document.querySelector('[aria-label="Conversation card settings"]')).toBeNull();
});

test("removing a card leaves normal posting intact", async () => {
	const h = harness();
	const remove = () => h.document.querySelector('[aria-label="Remove card"]') as any;
	configure(h);
	remove().click();
	await h.window.fetch("/i/api/graphql/id/CreateTweet", { body: JSON.stringify({ variables: { tweet_text: "Join us" } }) });
	expect(JSON.parse(h.requests[0].body).variables.xitter_conversation_card).toBeUndefined();
});

test("adding hashtag choices preserves the title and keeps the preview current", () => {
	const h = harness();
	let add: any, title: any, hashtag: any;
	configure(h);
	add = Array.from(h.document.querySelectorAll(".xitter-conversation button")).find((b) => b.textContent === "Add hashtag");
	add.click();
	title = h.document.querySelector(".xitter-conversation input");
	expect(title.disabled).toBeFalsy();
	expect(title.value).toBe("Pick a side");
	expect(h.document.querySelector(".xc-preview-title")!.textContent).toBe("Pick a side");
	hashtag = h.document.querySelectorAll(".xc-choice input")[1];
	hashtag.value = "#TeamDogs";
	hashtag.oninput();
	expect(h.document.querySelector('[aria-live="polite"]')!.textContent).toContain("#TeamDogs");
});

test("Request objects retain their method, headers and card data", async () => {
	const h = harness();
	const request = new Request("https://local.test/i/api/graphql/id/CreateTweet", { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": "test" }, body: JSON.stringify({ variables: { tweet_text: "Join us" } }) });
	configure(h);
	await h.window.fetch(request, undefined);
	expect(JSON.parse(h.requests[0].body).variables.xitter_conversation_card).toEqual(card());
	expect(request.method).toBe("POST");
	expect(request.headers.get("x-csrf-token")).toBe("test");
});

test("toolbar card icon inherits the native button and stays inside the scrolling icon row", () => {
	const h = harness();
	const cardButton = h.document.querySelector('[data-xitter-conversation]')!;
	const emoji = h.document.querySelector('[aria-label="Add emoji"]')!;
	expect(cardButton.className).toBe(emoji.className);
	expect(cardButton.querySelector("svg")!.getAttribute("class")).toBe(emoji.querySelector("svg")!.getAttribute("class"));
	expect(cardButton.querySelector("svg path")).not.toBeNull();
	expect(cardButton.textContent).toBe("");
	expect(cardButton.closest('[data-testid="ScrollSnap-List"]')).toBe(emoji.closest('[data-testid="ScrollSnap-List"]'));
	expect(cardButton.parentElement!.nextElementSibling).toBe(emoji.parentElement);
	expect(cardButton.getAttribute("aria-haspopup")).toBeNull();
});

test("editor keeps readable text and media controls across light, dim and dark palettes", async () => {
	const h = harness();
	let panel: any;
	configure(h);
	panel = h.document.querySelector('[aria-label="Conversation card settings"]');
	expect(panel.style.getPropertyValue("--xc-border")).toBe("rgb(207, 217, 222)");
	h.state.background = "rgb(0, 0, 0)";
	h.state.foreground = "rgb(231, 233, 234)";
	h.state.accent = "rgb(249, 24, 128)";
	await h.window.fetch("/i/api/graphql/id/HomeTimeline", {});
	await Bun.sleep(5);
	h.flush();
	expect(panel.style.getPropertyValue("--xc-border")).toBe("rgb(47, 51, 54)");
	expect(panel.style.getPropertyValue("--xc-muted")).toBe("rgb(139, 152, 165)");
	expect(panel.style.getPropertyValue("--xc-accent")).toBe("rgb(29, 155, 240)");
	expect(panel.style.getPropertyValue("--xc-button-bg")).toBe("rgb(239, 243, 244)");
	expect(panel.style.getPropertyValue("--xc-button-text")).toBe("rgb(15, 20, 25)");
	expect(panel.style.color).toBe(h.state.foreground);
	h.state.background = "rgb(21, 32, 43)";
	await h.window.fetch("/i/api/graphql/id/HomeTimeline", {});
	await Bun.sleep(5);
	h.flush();
	expect(panel.style.getPropertyValue("--xc-border")).toBe("rgb(56, 68, 77)");
});

test("icon toggles editor visibility with accessible expanded state and preserves entered fields", () => {
	const h = harness();
	const toolbarButton = h.document.querySelector('[data-xitter-conversation]') as any;
	let panel: any;
	configure(h);
	panel = h.document.querySelector('[aria-label="Conversation card settings"]');
	expect(toolbarButton.getAttribute("aria-expanded")).toBe("true");
	toolbarButton.click();
	expect(panel.hidden).toBe(true);
	expect(toolbarButton.getAttribute("aria-expanded")).toBe("false");
	toolbarButton.click();
	expect(panel.hidden).toBe(false);
	expect(toolbarButton.getAttribute("aria-expanded")).toBe("true");
	expect(panel.querySelector("input").value).toBe("Pick a side");
	(h.document.querySelector('[aria-label="Remove card"]') as any).click();
	expect(toolbarButton.getAttribute("aria-expanded")).toBe("false");
});

test("fetch sends the current CSRF cookie and preserves the remaining request headers", async () => {
	const h = harness();
	const body = JSON.stringify({ variables: { tweet_text: "Join us" } });
	configure(h);
	await h.window.fetch("/i/api/graphql/id/CreateTweet", { method: "POST", body, headers: { "x-csrf-token": "stale", "x-act-as-user-id": "123", "content-type": "application/json" } });
	expect(h.requests[0].headers.get("x-csrf-token")).toBe("current-session-csrf");
	expect(h.requests[0].headers.get("x-act-as-user-id")).toBe("123");
	expect(h.requests[0].headers.get("content-type")).toBe("application/json");
	h.document.cookie = "ct0=rotated-session-csrf";
	await h.window.fetch(new Request("https://local.test/i/api/graphql/id/CreateTweet", { method: "POST", body, headers: { "x-csrf-token": "stale", "x-act-as-user-id": "456" }, credentials: "include" }), undefined);
	expect(h.requests[1].headers.get("x-csrf-token")).toBe("rotated-session-csrf");
	expect(h.requests[1].headers.get("x-act-as-user-id")).toBe("456");
	expect(h.requests[1].credentials).toBe("include");
	expect(h.requests[1].method).toBe("POST");
});

test("XHR supplies missing CSRF headers and replaces stale tokens without appending duplicate values", () => {
	const h = harness();
	const xhr = new h.XHR(), missing = new h.XHR();
	xhr.open("POST", "/i/api/graphql/id/CreateTweet");
	xhr.setRequestHeader("X-CSRF-Token", "old");
	xhr.setRequestHeader("x-csrf-token", "another-stale-token");
	xhr.setRequestHeader("x-act-as-user-id", "123");
	xhr.send(JSON.stringify({ variables: {} }));
	expect(h.requests[0].headers.get("x-csrf-token")).toBe("current-session-csrf");
	expect(h.requests[0].headers.get("x-act-as-user-id")).toBe("123");
	missing.open("POST", "/i/api/graphql/id/CreateTweet");
	missing.send(JSON.stringify({ variables: {} }));
	expect(h.requests[1].headers.get("x-csrf-token")).toBe("current-session-csrf");
});

test("request hooks never send this instance's CSRF token to another origin", async () => {
	const h = harness();
	const xhr = new h.XHR();
	await h.window.fetch("https://elsewhere.test/i/api/graphql/id/CreateTweet", { method: "POST", headers: { "x-csrf-token": "external" } });
	expect(h.requests[0].headers.get("x-csrf-token")).toBe("external");
	xhr.open("POST", "https://elsewhere.test/i/api/graphql/id/CreateTweet");
	xhr.send("{}");
	expect(h.requests[1].headers.get("x-csrf-token")).toBeNull();
});

test("the composer can add four choices, remove one and add another without submitting the post", async () => {
	const h = harness();
	const panelButton = () => Array.from(h.document.querySelectorAll(".xitter-conversation button")).find((button) => button.textContent === "Add hashtag") as any;
	let add: any, hashtag: any, bubbled = 0;
	configure(h);
	h.document.querySelector("#composer")!.addEventListener("click", () => { bubbled += 1; });
	add = panelButton();
	add.click();add.click();add.click();
	expect(h.document.querySelectorAll(".xc-choice")).toHaveLength(4);
	expect(add.disabled).toBe(true);
	expect(bubbled).toBe(0);
	hashtag = h.document.querySelectorAll(".xc-choice input")[3] as any;
	hashtag.value = "#TeamBirds";hashtag.oninput();
	expect(hashtag.value).toBe("TeamBirds");
	expect(h.document.querySelectorAll(".xc-hashtag-prefix")).toHaveLength(4);
	(h.document.querySelectorAll('[aria-label="Remove hashtag"]')[1] as any).click();
	expect(h.document.querySelectorAll(".xc-choice")).toHaveLength(3);
	expect(add.disabled).toBe(false);
	add.click();
	expect(h.document.querySelectorAll(".xc-choice")).toHaveLength(4);
	await h.window.fetch("/i/api/graphql/id/CreateTweet", { method: "POST", body: JSON.stringify({ variables: { tweet_text: "Join us" } }) });
	expect(JSON.parse(h.requests[0].body).variables.xitter_conversation_card.choices[0].hashtag).toBe("#TeamCats");
});

test("automatic hashtags respect whole hashtag tokens and empty fields remain invalid", () => {
	expect(conversationCard({ choices: [{ hashtag: "Cats", text: "Hello" }] }).choices[0].hashtag).toBe("#Cats");
	expect(() => conversationCard({ choices: [{ hashtag: "", text: "Hello" }] })).toThrow();
	expect(conversationPostText({ hashtag: "#Cat", text: "Hello #Cats" })).toBe("Hello #Cats #Cat");
	expect(conversationPostText({ hashtag: "#Cat", text: "Hello #cat!" })).toBe("Hello #cat!");
});

test("every card textbox receives the field reset while native textboxes stay outside its scope", () => {
	const h = harness();
	const stylesheet = parseCSS(CONVERSATION_CARD_CSS);
	const fieldRules = Array.from(stylesheet.cssRules).filter((rule: any) => rule.selectorText && !rule.selectorText.includes(":")) as any[];
	let field: any, native: any, properties: Record<string, string>;
	configure(h);
	for (field of h.document.querySelectorAll(".xitter-conversation input,.xitter-conversation textarea")) {
		properties = {};
		fieldRules.filter((rule) => field.matches(rule.selectorText)).forEach((rule) => { properties = { ...properties, border: rule.style.border || properties.border, background: rule.style.background || properties.background, font: rule.style.font || properties.font, color: rule.style.color || properties.color }; });
		expect(properties.border).toBe("0");
		expect(properties.background).toBe("transparent");
		expect(properties.font).toBe("inherit");
		expect(properties.color).toBe("inherit");
	}
	native = h.document.createElement("input");h.document.body.appendChild(native);
	expect(fieldRules.some((rule) => native.matches(rule.selectorText))).toBe(false);
});

test("submitting a composer preserves the card when Draft text and request text differ", async () => {
	const h = harness();
	configure(h);
	(h.document.querySelector('[data-testid="tweetButtonInline"]') as any).click();
	await h.window.fetch("/i/api/graphql/id/CreateTweet", { method: "POST", body: JSON.stringify({ variables: { tweet_text: "Join us\u200b" } }) });
	expect(JSON.parse(h.requests[0].body).variables.xitter_conversation_card).toEqual(card());
});

test("a media-only conversation post and hashtag-only response need no tweet text", async () => {
	const h = harness();
	let text: any, data: any;
	configure(h);
	h.document.querySelector('[contenteditable="true"]')!.textContent = "";
	text = h.document.querySelector(".xc-choice textarea");text.value = "";
	(h.document.querySelector('[data-testid="tweetButtonInline"]') as any).click();
	await h.window.fetch("/i/api/graphql/id/CreateTweet", { method: "POST", body: JSON.stringify({ variables: { tweet_text: "", media: { media_entities: [{ media_id: "1" }] } } }) });
	data = JSON.parse(h.requests[0].body).variables;
	expect(data.tweet_text).toBe("");
	expect(conversationCard(data.xitter_conversation_card).choices[0].text).toBe("");
	expect(conversationPostText(data.xitter_conversation_card.choices[0])).toBe("#TeamCats");
});

test("posting from another composer does not pick up a card from an inactive composer", async () => {
	const h = harness();
	const other = h.document.querySelector("#composer")!.cloneNode(true) as any;
	configure(h);
	h.document.body.appendChild(other);
	other.querySelector('[data-testid="tweetButtonInline"]').click();
	await h.window.fetch("/i/api/graphql/id/CreateTweet", { method: "POST", body: JSON.stringify({ variables: { tweet_text: "Join us" } }) });
	expect(JSON.parse(h.requests[0].body).variables.xitter_conversation_card).toBeUndefined();
});

test("native toolbar replacement keeps the card configuration attached to its composer", async () => {
	const h = harness();
	const toolbar = h.document.querySelector('[data-testid="toolBar"]')!;
	let replacement: any;
	configure(h);
	replacement = toolbar.cloneNode(true);
	replacement.querySelector('[data-xitter-conversation]').parentElement.remove();
	toolbar.replaceWith(replacement);
	replacement.querySelector('[data-testid="tweetButtonInline"]').click();
	await h.window.fetch("/i/api/graphql/id/CreateTweet", { method: "POST", body: JSON.stringify({ variables: JSON.stringify({ tweet_text: "Join us" }) }) });
	expect(JSON.parse(JSON.parse(h.requests[0].body).variables).xitter_conversation_card).toEqual(card());
	(h.document.querySelector('[aria-label="Remove card"]') as any).click();
	replacement.querySelector('[data-testid="tweetButtonInline"]').click();
	await h.window.fetch("/graphql/id/CreateTweet", { method: "POST", body: JSON.stringify({ variables: { tweet_text: "Join us" } }) });
	expect(JSON.parse(h.requests[1].body).variables.xitter_conversation_card).toBeUndefined();
});

test("localhost's bare GraphQL path carries the card and CSRF token through fetch and XHR", async () => {
	const h = harness();
	const xhr = new h.XHR();
	configure(h);
	(h.document.querySelector('[data-testid="tweetButtonInline"]') as any).click();
	await h.window.fetch("/graphql/id/CreateTweet", { method: "POST", body: JSON.stringify({ variables: { tweet_text: "" } }) });
	expect(JSON.parse(h.requests[0].body).variables.xitter_conversation_card).toEqual(card());
	expect(h.requests[0].headers.get("x-csrf-token")).toBe("current-session-csrf");
	xhr.open("POST", "https://local.test/graphql/id/CreateTweet");
	xhr.send(JSON.stringify({ variables: { tweet_text: "" } }));
	expect(JSON.parse(h.requests[1].body).variables.xitter_conversation_card).toEqual(card());
	expect(h.requests[1].headers.get("x-csrf-token")).toBe("current-session-csrf");
});

test("localhost card-preview requests receive CSRF headers", async () => {
	const h = harness();
	await h.window.fetch("/v2/cards/preview.json", { method: "POST", body: "status=card%3A%2F%2F123" });
	expect(h.requests[0].headers.get("x-csrf-token")).toBe("current-session-csrf");
});

test("the session token from the page overrides an already stale or shadowed ct0 cookie", async () => {
	const h = harness({ csrf: "server-session-token", cookie: "ct0=stale-path-token; ct0=server-session-token" });
	const xhr = new h.XHR();
	await h.window.fetch("/graphql/id/CreateTweet", { method: "POST", headers: { "x-csrf-token": "stale-native-token" }, body: JSON.stringify({ variables: {} }) });
	expect(h.requests[0].headers.get("x-csrf-token")).toBe("server-session-token");
	xhr.open("POST", "/i/api/graphql/id/CreateTweet");
	xhr.setRequestHeader("x-csrf-token", "stale-native-token");
	xhr.send("{}");
	expect(h.requests[1].headers.get("x-csrf-token")).toBe("server-session-token");
});

test("a session boot token does not override a later account switch", async () => {
	const h = harness({ csrf: "first-session-token", cookie: "ct0=first-session-token" });
	h.document.cookie = "ct0=second-session-token";
	await h.window.fetch("/graphql/id/CreateTweet", { method: "POST", body: "{}" });
	expect(h.requests[0].headers.get("x-csrf-token")).toBe("second-session-token");
});

test("image and video uploads carry CSRF without changing multipart bodies or upload headers", async () => {
	const h = harness({ csrf: "server-session-token", cookie: "ct0=old" });
	const body = new FormData();
	const paths = ["/i/media/upload.json", "/i/media/upload2.json", "/1.1/media/upload.json", "/i/api/i/media/upload.json", "/i/api/1.1/media/upload.json"];
	let path: string, request: any, xhr: any;
	body.append("media", new Blob(["image fixture"], { type: "image/png" }), "fixture.png");
	for (path of paths) {
		await h.window.fetch(path, { method: "POST", body, headers: { "x-act-as-user-id": "123" } });
		request = h.requests.at(-1);
		expect(request.headers.get("x-csrf-token")).toBe("server-session-token");
		expect(request.headers.get("x-act-as-user-id")).toBe("123");
		expect(request.body).toBe(body);
		expect(request.headers.has("content-type")).toBe(false);
		xhr = new h.XHR();xhr.open("POST", path);xhr.send(body);
		expect(h.requests.at(-1).headers.get("x-csrf-token")).toBe("server-session-token");
		expect(h.requests.at(-1).body).toBe(body);
	}
});

test("the card's media picker opens the composer's native upload input", () => {
	const h = harness();
	const input = h.document.createElement("input");
	let clicked = 0;
	input.type = "file";input.setAttribute("data-testid", "fileInput");
	input.addEventListener("click", () => { clicked += 1; });
	h.document.querySelector('[data-testid="toolBar"]')!.appendChild(input);
	configure(h);
	(Array.from(h.document.querySelectorAll(".xitter-conversation button")).find((button) => button.textContent === "Add image or video") as any).click();
	expect(clicked).toBe(1);
});

test("missing card media produces an inline attachment message", async () => {
	const h = harness();
	configure(h);
	(h.document.querySelector('[data-testid="tweetButtonInline"]') as any).click();
	await h.window.fetch("/graphql/id/CreateTweet", { method: "POST", body: JSON.stringify({ variables: { tweet_text: "Needs media", media: { media_entities: [] } } }) });
	expect(h.document.querySelector('.xc-media-status[role="alert"]')!.textContent).toBe("Add exactly one image or video before posting this card.");
});

test("fetch shows the card validation message inline and preserves fields for retry", async () => {
	const h = harness();
	let error: any;
	configure(h);
	h.state.response = { errors: [{ code: 214, message: "Error: Each hashtag must be different." }] };
	await h.window.fetch("/graphql/id/CreateTweet", { method: "POST", body: JSON.stringify({ variables: { tweet_text: "Join us" } }) });
	await Bun.sleep(5);
	error = h.document.querySelector(".xc-error");
	expect(error.hidden).toBe(false);
	expect(error.textContent).toBe("Each hashtag must be different.");
	expect(h.document.querySelector<HTMLInputElement>(".xc-choice input")!.value).toBe("TeamCats");
	h.state.response = {};
	await h.window.fetch("/graphql/id/CreateTweet", { method: "POST", body: JSON.stringify({ variables: { tweet_text: "Join us" } }) });
	expect(error.hidden).toBe(true);
});

test("XHR shows the precise publishing error without attributing unrelated failures to the card", async () => {
	const h = harness();
	const xhr = new h.XHR();
	let error: any;
	configure(h);
	h.state.response = { errors: [{ code: 214, message: "Choose your own finished image or video upload." }] };
	xhr.open("POST", "/graphql/id/CreateTweet");
	xhr.send(JSON.stringify({ variables: { tweet_text: "Join us" } }));
	error = h.document.querySelector(".xc-error");
	expect(error.hidden).toBe(false);
	expect(error.textContent).toBe("Choose your own finished image or video upload.");
	error.hidden = true;
	h.state.response = { errors: [{ code: 214, message: "Unrelated timeline error" }] };
	await h.window.fetch("/graphql/id/HomeTimeline", {});
	await Bun.sleep(5);
	expect(error.hidden).toBe(true);
});

function attachment(h: ReturnType<typeof harness>, kind = "img", src = "blob:attachment") {
	const container = h.document.createElement("div");
	const media = h.document.createElement(kind);
	const edit = h.document.createElement("button");
	const remove = h.document.createElement("button");
	const actions = { edits: 0, removals: 0 };
	container.setAttribute("data-testid", "attachments");
	media.setAttribute("src", src);
	edit.setAttribute("aria-label", "Edit media");
	remove.setAttribute("aria-label", "Remove media");
	edit.addEventListener("click", () => { actions.edits += 1; });
	remove.addEventListener("click", () => { actions.removals += 1; container.remove(); });
	container.append(media, edit, remove);
	h.document.querySelector("#composer")!.prepend(container);
	return { container, media, edit, remove, actions };
}

test("the card previews its attachment and forwards crop and remove to native media controls", async () => {
	const h = harness();
	const media = attachment(h);
	let preview: any;
	configure(h);
	preview = h.document.querySelector(".xc-media-preview");
	expect(preview.getAttribute("src")).toBe("blob:attachment");
	expect(media.container.classList.contains("xitter-card-attachment")).toBe(true);
	expect((h.document.querySelector(".xc-media-empty") as any).hidden).toBe(true);
	(h.document.querySelector(".xc-media-actions button") as any).click();
	expect(media.actions.edits).toBe(1);
	media.media.setAttribute("src", "blob:cropped");
	await h.window.fetch("/graphql/id/HomeTimeline", {});
	await Bun.sleep(5);
	h.flush();
	expect(h.document.querySelector(".xc-media-preview")!.getAttribute("src")).toBe("blob:cropped");
	(h.document.querySelectorAll(".xc-media-actions button")[1] as any).click();
	await h.window.fetch("/graphql/id/HomeTimeline", {});
	await Bun.sleep(5);
	h.flush();
	expect(media.actions.removals).toBe(1);
	expect(h.document.querySelector(".xc-media-preview")).toBeNull();
	expect((h.document.querySelector(".xc-media-empty") as any).hidden).toBe(false);
});

test("collapsing or removing a card restores the native attachment", () => {
	const h = harness();
	const media = attachment(h);
	const toggle = h.document.querySelector('[data-xitter-conversation]') as any;
	configure(h);
	toggle.click();
	expect(media.container.classList.contains("xitter-card-attachment")).toBe(false);
	toggle.click();
	expect(media.container.classList.contains("xitter-card-attachment")).toBe(true);
	(h.document.querySelector('[aria-label="Remove card"]') as any).click();
	expect(media.container.classList.contains("xitter-card-attachment")).toBe(false);
});

test("the video preview keeps playback controls and does not restart during redraw", async () => {
	const h = harness();
	const media = attachment(h, "video", "blob:video");
	let preview: any;
	media.media.setAttribute("poster", "blob:poster");
	configure(h);
	preview = h.document.querySelector(".xc-media-preview");
	expect(preview.tagName).toBe("VIDEO");
	expect(preview.controls).toBe(true);
	expect(preview.poster).toBe("blob:poster");
	expect(h.document.querySelector(".xc-media-actions button")!.textContent).toBe("Edit video");
	await h.window.fetch("/graphql/id/HomeTimeline", {});
	await Bun.sleep(5);
	h.flush();
	expect(h.document.querySelector(".xc-media-preview")).toBe(preview);
});

test("GIF previews keep their original source and omit unavailable crop controls", () => {
	const h = harness();
	const media = attachment(h, "img", "blob:animated-gif");
	media.edit.remove();
	configure(h);
	expect(h.document.querySelector(".xc-media-preview")!.getAttribute("src")).toBe("blob:animated-gif");
	expect((h.document.querySelector(".xc-media-actions button") as any).hidden).toBe(true);
});

test("multiple attachments keep native removal controls visible until only one remains", () => {
	const h = harness();
	const media = attachment(h);
	const second = media.remove.cloneNode(true);
	media.container.appendChild(second);
	configure(h);
	expect(media.container.classList.contains("xitter-card-attachment")).toBe(false);
	expect(h.document.querySelector('.xc-media-status[role="alert"]')!.textContent).toContain("Keep exactly one");
});

test("GIF attachments retain access to the native description editor", () => {
	const h = harness();
	const media = attachment(h, "img", "blob:animated-gif");
	const description = h.document.createElement("a");
	let opened = false;
	media.edit.remove();
	description.setAttribute("data-testid", "altTextWrapper");
	description.addEventListener("click", () => { opened = true; });
	media.container.append(description);
	configure(h);
	expect(h.document.querySelector(".xc-media-actions button")!.textContent).toBe("Edit description");
	(h.document.querySelector(".xc-media-actions button") as any).click();
	expect(opened).toBe(true);
});

test("thank-you destinations accept web URLs and reject invalid or executable destinations", () => {
	const valid = conversationCard({ ...card(), thanksUrl: " https://example.com ", thanksDisplayUrl: " Learn more " });
	const invalid = ["javascript:alert(1)", "data:text/html,test", "file:///tmp/test", "//example.com", "example.com", "https://", "https://user:password@example.com", "https://exam\nple.com"];
	let url: string;
	expect(valid.thanksUrl).toBe("https://example.com/");
	expect(valid.thanksDisplayUrl).toBe("Learn more");
	for (url of invalid) expect(() => conversationCard({ ...card(), thanksUrl: url })).toThrow(/valid thank-you URL/);
	expect(() => conversationCard({ ...card(), thanksDisplayUrl: "example.com" })).toThrow(/Add a thank-you URL/);
	expect(() => conversationCard({ ...card(), thanksUrl: 123 })).toThrow();
	expect(() => conversationCard({ ...card(), thanksUrl: "https://example.com/" + "a".repeat(2048) })).toThrow();
	expect(() => conversationCard({ ...card(), thanksUrl: "https://example.com", thanksDisplayUrl: "a".repeat(101) })).toThrow();
});

test("the after-posting preview and submitted card include the thank-you destination and display URL", async () => {
	const h = harness();
	let fields: any, preview: any, toggle: any, data: any;
	configure(h);
	fields = h.document.querySelectorAll(".xc-link-fields input");
	fields[0].value = "https://example.com";
	fields[1].value = "example.com";
	fields[0].oninput();
	toggle = Array.from(h.document.querySelectorAll(".xc-preview-tabs button"))[1] as any;
	toggle.click();
	preview = h.document.querySelector(".xc-thanks-preview");
	expect(preview.hidden).toBe(false);
	expect(preview.querySelector("p").textContent).toBe("Thanks for joining!");
	expect(preview.querySelector("a").getAttribute("href")).toBe("https://example.com/");
	expect(preview.querySelector("a").textContent).toBe("example.com");
	expect(toggle.getAttribute("aria-pressed")).toBe("true");
	await h.window.fetch("/graphql/id/CreateTweet", { method: "POST", body: JSON.stringify({ variables: { tweet_text: "Join us" } }) });
	data = JSON.parse(h.requests[0].body).variables.xitter_conversation_card;
	expect(data.thanksUrl).toBe("https://example.com/");
	expect(data.thanksDisplayUrl).toBe("example.com");
	fields[0].value = "javascript:alert(1)";fields[0].oninput();
	expect(preview.querySelector("a").hasAttribute("href")).toBe(false);
});

test("publishing a card with a thank-you URL clears its composer settings after success", async () => {
	const h = harness();
	let fields: any;
	configure(h);
	fields = h.document.querySelectorAll(".xc-link-fields input");
	fields[0].value = "https://example.com";
	fields[1].value = "example.com";
	h.state.response = { data: { create_tweet: { tweet_results: { result: { xitter_conversation_card: conversationCard({ ...card(), thanksUrl: "https://example.com", thanksDisplayUrl: "example.com" }) } } } } };
	await h.window.fetch("/graphql/id/CreateTweet", { method: "POST", body: JSON.stringify({ variables: { tweet_text: "Join us" } }) });
	await Bun.sleep(5);
	expect(h.document.querySelector(".xitter-conversation")).toBeNull();
});

test("the card panel stays outside the sticky toolbar so it cannot cover the tweet field", async () => {
	const h = harness();
	const root = h.document.querySelector("#composer")!;
	const toolbar = h.document.querySelector('[data-testid="toolBar"]')!;
	const sticky = h.document.createElement("div");
	const wrapper = h.document.createElement("div");
	let panel: any;
	sticky.style.position = "sticky";
	root.appendChild(sticky);sticky.appendChild(wrapper);wrapper.appendChild(toolbar);
	configure(h);
	panel = h.document.querySelector(".xitter-conversation")!;
	expect(panel.parentElement).toBe(root);
	expect(panel.nextElementSibling).toBe(sticky);
	expect(sticky.contains(panel)).toBe(false);
	panel.remove();
	await h.window.fetch("/graphql/id/HomeTimeline", {});
	await Bun.sleep(5);
	h.flush();
	expect(panel.parentElement).toBe(root);
	expect(panel.nextElementSibling).toBe(sticky);
});

test("saving an unrelated draft does not pick up another composer's conversation card", async () => {
	const h = harness();
	configure(h);
	await h.window.fetch("/graphql/id/CreateDraftTweet", { method: "POST", body: JSON.stringify({ variables: { post_tweet_request: { status: "An unrelated draft" } } }) });
	expect(JSON.parse(h.requests[0].body).variables.post_tweet_request.xitter_conversation_card).toBeUndefined();
	await h.window.fetch("/graphql/id/CreateDraftTweet", { method: "POST", body: JSON.stringify({ variables: { post_tweet_request: { status: "Join us" } } }) });
	expect(JSON.parse(h.requests[1].body).variables.post_tweet_request.xitter_conversation_card).toEqual(card());
});

test("drafts retain incomplete hashtags without allowing them to publish", () => {
	const draft = conversationCard({ title: "Work in progress", choices: [{ hashtag: "#", text: "" }] }, () => false, true);
	expect(draft.choices[0].hashtag).toBe("");
	expect(() => conversationCard(draft)).toThrow(/Use a hashtag/);
});

test("opening a native draft restores all conversation-card fields and can publish them again", async () => {
	const h = harness();
	const saved = { ...card(), thanksUrl: "https://example.com/thanks", thanksDisplayUrl: "example.com", choices: [...card().choices, { hashtag: "#TeamDogs", text: "Go dogs" }] };
	const event = new h.document.defaultView.CustomEvent("xitter:restore-conversation-cards", { detail: { status: "Join us", xitter_conversation_card: saved } });
	h.document.dispatchEvent(event);h.flush();
	expect(h.document.querySelectorAll(".xc-choice")).toHaveLength(2);
	expect((h.document.querySelector(".xc-fields input") as any).value).toBe(saved.title);
	expect((h.document.querySelector(".xc-link-fields input") as any).value).toBe(saved.thanksUrl);
	expect((h.document.querySelectorAll(".xc-choice textarea")[1] as any).value).toBe("Go dogs");
	expect(h.window.__XITTER_CONVERSATION_HAS_DRAFT__()).toBe(true);
	await h.window.fetch("/graphql/id/CreateTweet", { method: "POST", body: JSON.stringify({ variables: { tweet_text: "Join us" } }) });
	expect(JSON.parse(h.requests[0].body).variables.xitter_conversation_card).toEqual(saved);
});

test("restoring a plain draft clears previous card settings from its reused composer", async () => {
	const h = harness();
	const event = new h.document.defaultView.CustomEvent("xitter:restore-conversation-cards", { detail: { status: "Join us" } });
	configure(h);
	h.document.dispatchEvent(event);h.flush();
	expect(h.document.querySelector(".xitter-conversation")).toBeNull();
	expect(h.window.__XITTER_CONVERSATION_HAS_DRAFT__()).toBe(false);
	await h.window.fetch("/graphql/id/CreateTweet", { method: "POST", body: JSON.stringify({ variables: { tweet_text: "Join us" } }) });
	expect(JSON.parse(h.requests[0].body).variables.xitter_conversation_card).toBeUndefined();
});

test("a text-free draft waits for its modal composer instead of restoring into the home composer", async () => {
	const h = harness();
	const root = h.document.querySelector("#composer")!;
	const editor = h.document.querySelector('[contenteditable="true"]')!;
	const event = new h.document.defaultView.CustomEvent("xitter:restore-conversation-cards", { detail: { status: "", xitter_conversation_card: card() } });
	root.removeAttribute("role");editor.textContent = "";
	h.document.dispatchEvent(event);h.flush();
	expect(h.document.querySelector(".xitter-conversation")).toBeNull();
	root.setAttribute("role", "dialog");
	await h.window.fetch("/graphql/id/HomeTimeline", {});await Bun.sleep(5);h.flush();
	expect((h.document.querySelector(".xc-fields input") as any).value).toBe("Pick a side");
});

test("calendar navigation retains card settings when the native composer is remounted", async () => {
	const h = harness();
	const schedule = h.document.createElement("button");
	let replacement: any;
	configure(h);
	schedule.setAttribute("data-testid", "scheduleOption");
	h.document.querySelector('[data-testid="toolBar"]')!.appendChild(schedule);
	schedule.click();
	h.location.pathname = "/compose/post/schedule";
	replacement = h.document.querySelector("#composer")!.cloneNode(true) as any;
	replacement.querySelector(".xitter-conversation").remove();
	replacement.querySelector('[data-xitter-conversation]').parentElement.remove();
	h.document.querySelector("#composer")!.remove();
	await h.window.fetch("/graphql/id/HomeTimeline", {});await Bun.sleep(5);h.flush();
	h.document.body.appendChild(replacement);h.location.pathname = "/compose/post";
	await h.window.fetch("/graphql/id/HomeTimeline", {});await Bun.sleep(5);h.flush();
	expect((h.document.querySelector(".xc-fields input") as any).value).toBe("Pick a side");
	await h.window.fetch("/graphql/id/CreateScheduledTweet", { body: JSON.stringify({ variables: { post_tweet_request: { status: "Join us" } } }) });
	expect(JSON.parse(h.requests.at(-1).body).variables.post_tweet_request.xitter_conversation_card).toEqual(card());
});
