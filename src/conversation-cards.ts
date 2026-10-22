export type ConversationCard = {
	title: string;
	thanks: string;
	thanksUrl?: string;
	thanksDisplayUrl?: string;
	choices: { hashtag: string; text: string }[];
};

export function conversationCard(raw: unknown, forbidden: (text: string) => boolean = () => false, draft = false): ConversationCard {
	let data: Record<string, unknown>, title: string, thanks: string, thanksUrl: string, thanksDisplayUrl: string, url: URL, choices: ConversationCard["choices"], seen: Set<string>;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid conversation card.");
	data = raw as Record<string, unknown>;
	title = cardText(data.title, 23, forbidden);
	thanks = cardText(data.thanks, 23, forbidden);
	thanksUrl = cardText(data.thanksUrl, 2048, forbidden);
	thanksDisplayUrl = cardText(data.thanksDisplayUrl, 100, forbidden);
	if (thanksUrl) {
		try { url = new URL(thanksUrl); }
		catch { throw new Error("Enter a valid thank-you URL starting with https:// or http://."); }
		if (!/^https?:$/.test(url.protocol) || url.username || url.password || /[\s\u0000-\u001f\u007f]/u.test(thanksUrl)) throw new Error("Enter a valid thank-you URL starting with https:// or http://.");
		thanksUrl = url.href;
	}
	if (thanksDisplayUrl && !thanksUrl) throw new Error("Add a thank-you URL before setting its display URL.");
	if (!Array.isArray(data.choices) || data.choices.length < 1 || data.choices.length > 4) throw new Error("A conversation card needs 1 to 4 hashtags.");
	seen = new Set();
	choices = data.choices.map((rawChoice) => {
		let choice: Record<string, unknown>, hashtag: string, text: string, key: string;
		if (!rawChoice || typeof rawChoice !== "object" || Array.isArray(rawChoice)) throw new Error("Invalid conversation card choice.");
		choice = rawChoice as Record<string, unknown>;
		hashtag = cardText(choice.hashtag, 20, () => false);
		if (hashtag && !hashtag.startsWith("#")) hashtag = `#${hashtag}`;
		hashtag = cardText(hashtag, 20, forbidden);
		text = cardText(choice.text, 256, forbidden);
		if (draft && hashtag === "#") hashtag = "";
		if (!(draft && !hashtag) && (!/^#[\p{L}\p{N}_]+$/u.test(hashtag) || !/[\p{L}_]/u.test(hashtag))) throw new Error("Use a hashtag starting with # and containing letters, numbers or underscores.");
		key = hashtag.toLocaleLowerCase();
		if (hashtag && seen.has(key)) throw new Error("Each hashtag must be different.");
		seen.add(key);
		return { hashtag, text };
	});
	return { title, thanks, ...(thanksUrl ? { thanksUrl } : {}), ...(thanksDisplayUrl ? { thanksDisplayUrl } : {}), choices };
}

function cardText(value: unknown, limit: number, forbidden: (text: string) => boolean): string {
	let text: string;
	if (value === undefined) return "";
	if (typeof value !== "string") throw new Error("Conversation card fields must be text.");
	text = value.trim();
	if ([...text].length > limit) throw new Error(`Conversation card field exceeds ${limit} characters.`);
	if (forbidden(text)) throw new Error("A conversation card contains text this instance doesn't allow.");
	return text;
}

export type ConversationCreative = {
	kind: string;
	url: string;
	width: number;
	height: number;
	poster?: string;
	stream?: string;
	duration?: number | null;
};

export function conversationCardEntity(card: ConversationCard, id: string, creative: ConversationCreative) {
	const string = (value: string) => ({ type: "STRING", string_value: value });
	const image = (url: string) => ({ type: "IMAGE", image_value: { url, width: creative.width, height: creative.height } });
	const values: Record<string, unknown> = {
		card_id: string(id), card_url: string(`card://${id}`),
		thank_you_text: string(card.thanks || "Thanks for joining!"),
	};
	const names = ["one", "two", "three", "four"];
	if (card.title) values.title = string(card.title);
	if (card.thanksUrl) {
		values.thank_you_url = string(card.thanksUrl);
		if (card.thanksDisplayUrl) values.thank_you_vanity_url = string(card.thanksDisplayUrl);
	}
	card.choices.forEach((choice, index) => {
		values[`cta_${names[index]}`] = string(choice.hashtag);
		values[`cta_${names[index]}_tweet`] = string(conversationPostText(choice));
	});
	if (creative.kind === "video") {
		values.player_width = string(String(creative.width));
		values.player_height = string(String(creative.height));
		values.player_image_original = image(creative.poster!);
		values.player_stream_url = string(creative.stream!);
		values.content_duration_seconds = string(String((creative.duration ?? 1000) / 1000));
	} else values.promo_image = image(creative.url);
	return {
		rest_id: `card://${id}`,
		legacy: {
			name: creative.kind === "video" ? "promo_video_convo" : "promo_image_convo",
			url: `card://${id}`,
			binding_values: Object.entries(values).map(([key, value]) => ({ key, value })),
			card_platform: { platform: { audience: { name: "production" }, device: { name: "Swift", version: "12" } } },
			user_refs_results: [],
		},
	};
}

export function conversationPostText(choice: ConversationCard["choices"][number]): string {
	const hashtags = choice.text.match(/#[\p{L}\p{N}_]+/gu) ?? [];
	return hashtags.some((tag) => tag.toLocaleLowerCase() === choice.hashtag.toLocaleLowerCase()) ? choice.text : [choice.text, choice.hashtag].filter(Boolean).join(" ");
}

export function conversationVideoMap(id: string, url: string, ownerId = id): string {
	const escape = (text: string) => text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char]!);
	return `<vmap:VMAP xmlns:vmap="http://www.iab.net/videosuite/vmap" xmlns:tw="http://twitter.com/schema/videoVMapV2.xsd" version="1.0"><tw:content contentId="${escape(id)}" ownerId="${escape(ownerId)}"><MediaFile type="video/mp4">${escape(url)}</MediaFile></tw:content></vmap:VMAP>`;
}
