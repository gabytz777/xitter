// Equicoins shop. Purchases are charged up front and stay pending
// until a moderator or admin approves them; a rejection refunds the wallet.
// An invite code is the exception: it is made at once (nothing to review).
// What a request carries is checked here, before any money moves; approving
// it (money-admin.ts reviewShopOrder) delivers it.

import { isBlockedEitherWay } from "./blocks";
import { sql } from "./db";
import { newId } from "./ids";
import { hateIn } from "./hate";
import { createInvite } from "./invites";
import { hasBlockedPhrase } from "./settings";
import { settings } from "./settings";
import { BADGE_TYPES, sniffImage } from "./media";
import { accountFor, economy } from "./money";

export class ShopError extends Error {}
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export const SHOP_KINDS = ["badge", "custom_badge", "announcement", "checkmark", "invite", "hashflag", "sticker_pack", "explore_card", "boost"];
export const KIND_LABEL: Record<string, string> = {
	badge: "Badge",
	custom_badge: "Custom badge",
	announcement: "Announcement",
	checkmark: "Blue checkmark",
	invite: "Invite code",
	hashflag: "Hashflag",
	sticker_pack: "Sticker pack",
	explore_card: "Explore card",
	boost: "Post boost",
};
// what lasts, and how many days a new listing gives by default
export const SHOP_DAYS: Record<string, number> = { checkmark: 30, hashflag: 7, explore_card: 1, boost: 1 };
// what a buyer can give to another account here
const GIFTS = new Set(["badge", "custom_badge", "checkmark"]);
const MAX_STICKERS = 6;
const INVITE_DAYS = 30;

export type ShopInput = {
	text?: string;
	link?: string;
	badgeName?: string;
	badgeImage?: Buffer;
	gift?: string;
	hashtag?: string;
	emoji?: Buffer;
	packName?: string;
	stickers?: Buffer[];
	title?: string;
	summary?: string;
	query?: string;
	picture?: Buffer;
	post?: string;
};
type File = { name: string; image: Buffer; mime: string };

const clean = (s: string | undefined) => (s ?? "").trim();
function words(s: string, max: number, what: string, required = false) {
	if (required && !s) throw new ShopError(`${what} can't be empty.`);
	if ([...s].length > max) throw new ShopError(`${what} is up to ${max} characters.`);
	if (s && (hateIn(s) || hasBlockedPhrase(s))) throw new ShopError(`${what} can't be used.`);
	return s;
}
function picture(b: Buffer | undefined, types: string[], maxBytes: number, maxSide: number, what: string) {
	const info = b ? sniffImage(b) : undefined;
	const kinds = types.map((t) => ({ "image/png": "PNG", "image/jpeg": "JPEG", "image/gif": "GIF", "image/webp": "WebP" })[t] ?? t).join(", ");
	if (!b || b.length > maxBytes || !info || !types.includes(info.mime) || info.width > maxSide || info.height > maxSide)
		throw new ShopError(`${what}: use a ${kinds} up to ${maxSide}×${maxSide} and ${Math.round(maxBytes / 1024)} KB.`);
	return info;
}

// a post id from its link (…/status/<id>) or the id itself
const postIdOf = (s: string) => /\/status(?:es)?\/(\d{1,19})/.exec(s)?.[1] ?? (/^\d{1,19}$/.test(s) ? s : undefined);

// What a request of this kind carries: the payload kept on the order and the
// pictures kept beside it until it's reviewed.
function requestOf(kind: string, input: ShopInput): { payload: Record<string, unknown>; files: File[] } {
	switch (kind) {
		case "announcement": {
			const text = words(clean(input.text), 500, "The announcement", true);
			const link = clean(input.link);
			if (link && (!/^https?:\/\/[^\s]+$/i.test(link) || link.length > 500)) throw new ShopError("Use a full http or https link, up to 500 characters.");
			return { payload: { text, link }, files: [] };
		}
		case "custom_badge": {
			const name = words(clean(input.badgeName), 60, "The badge name", true);
			const info = picture(input.badgeImage, BADGE_TYPES, 256 * 1024, 1024, "The badge image");
			return { payload: { name, image: input.badgeImage!.toString("base64"), mime: info.mime }, files: [] };
		}
		case "hashflag": {
			const hashtag = clean(input.hashtag).replace(/^#/, "");
			if (!/^[\p{L}\p{N}_]{1,100}$/u.test(hashtag)) throw new ShopError("A hashtag is letters, digits and underscores.");
			words(hashtag, 100, "The hashtag");
			const info = picture(input.emoji, ["image/png", "image/gif", "image/webp"], 256 * 1024, 512, "The emoji");
			return { payload: { hashtag }, files: [{ name: hashtag, image: input.emoji!, mime: info.mime }] };
		}
		case "sticker_pack": {
			const name = words(clean(input.packName), 40, "The pack name", true);
			const stickers = input.stickers ?? [];
			if (!stickers.length) throw new ShopError("Add at least one sticker.");
			if (stickers.length > MAX_STICKERS) throw new ShopError(`A pack has up to ${MAX_STICKERS} stickers.`);
			const files = stickers.map((image, i) => ({ name: "", image, mime: picture(image, ["image/png", "image/gif", "image/webp"], 512 * 1024, 1024, `Sticker ${i + 1}`).mime }));
			return { payload: { name }, files };
		}
		case "explore_card": {
			const title = words(clean(input.title), 100, "The title", true);
			const summary = words(clean(input.summary), 280, "The summary");
			const query = words(clean(input.query), 200, "The search", true);
			if (!input.picture) return { payload: { title, summary, query }, files: [] };
			const info = picture(input.picture, ["image/png", "image/jpeg", "image/webp"], 1024 * 1024, 4096, "The picture");
			return { payload: { title, summary, query, width: info.width, height: info.height }, files: [{ name: "", image: input.picture, mime: info.mime }] };
		}
		case "boost": {
			const postId = postIdOf(clean(input.post));
			if (!postId) throw new ShopError("Paste the link to one of your posts.");
			return { payload: { postId }, files: [] };
		}
		default:
			return { payload: {}, files: [] };
	}
}

export async function shopItems(approvedOnly = false) {
	const local = await sql`select i.id::text, i.name, i.description, i.price_cents::bigint as price, i.kind, i.badge_id::text, i.days,
		b.name as badge_name, i.active, i.status, i.created_by::text, i.approved_by::text, u.screen_name as creator
		from money_shop_items i left join custom_badges b on b.id = i.badge_id left join users u on u.id = i.created_by
		where (i.kind <> 'badge' or b.id is not null) and (${approvedOnly} = false or (i.status = 'approved' and i.active)) order by i.created_at desc, i.id desc`;
	if (!approvedOnly) return local;
	const remote = await sql`select remote_id::text as id, name, description, price_cents::bigint as price, kind, null::text as badge_id, days,
		badge_name, active, status, null::text as created_by, reviewed_by::text as approved_by, origin as creator, origin as remote_origin,
		badge_mime
		from money_remote_shop_items where source_active and active and status = 'approved' order by updated_at desc, remote_id desc`;
	return [...local, ...remote.map((i: any) => ({ ...i, active: !!i.active, badge_url: `/account/money/shop/badge/${encodeURIComponent(i.remote_origin)}/${i.id}` }))];
}

export async function buyShopItem(userId: string, itemId: string, input: ShopInput) {
	if (!settings().money_shop.enabled) throw new ShopError("The shop is closed.");
	if (!/^\d{1,19}$/.test(itemId)) throw new ShopError("That shop item isn't available.");
	const [listed] = await sql`select kind from money_shop_items where id = ${itemId}::bigint and active and status = 'approved'`;
	if (!listed) throw new ShopError("That shop item isn't available.");
	const kind: string = listed.kind;
	if (kind === "invite" && settings().signup_mode === "open") throw new ShopError("Anyone can sign up here right now, so there's no invite to buy.");
	const { payload, files } = requestOf(kind, input);
	let recipientId: string | null = null;
	const giftTo = clean(input.gift);
	if (giftTo) {
		if (!GIFTS.has(kind)) throw new ShopError("This item can't be given to someone else.");
		const to = await accountFor(giftTo);
		if (!to || to.instance) throw new ShopError("There's no account here with that username.");
		if (to.id !== userId) {
			if (await isBlockedEitherWay(userId, to.id)) throw new ShopError(`You can't give this to @${to.screen_name}.`);
			recipientId = to.id;
		}
	}
	const target = recipientId ?? userId;
	return sql.begin(async (tx) => {
		await tx`insert into money_wallets (user_id, balance_cents) values (${userId}::bigint, ${economy().starting_cents}) on conflict (user_id) do nothing`;
		const [item] = await tx`select id::text, name, price_cents::bigint as price, kind, badge_id::text, days
			from money_shop_items where id = ${itemId}::bigint and active and status = 'approved' for update`;
		if (!item || item.kind !== kind) throw new ShopError("That shop item isn't available.");
		const them = recipientId ? "They" : "You";
		if (kind === "badge") {
			const [owned] = await tx`select 1 from user_badges where user_id = ${target}::bigint and badge_id = ${item.badge_id}::bigint`;
			if (owned) throw new ShopError(`${them} already have this badge.`);
			payload.badgeId = item.badge_id;
		}
		if (kind === "checkmark") {
			const [u] = await tx`select verified_type, shop_verified_until from users where id = ${target}::bigint`;
			if (u?.verified_type && !u.shop_verified_until) throw new ShopError(`${them} already have a checkmark.`);
		}
		if (kind === "boost") {
			const [own] = await tx`select 1 from posts where id = ${payload.postId as string}::bigint and user_id = ${userId}::bigint and not hidden`;
			if (!own) throw new ShopError("You can only boost your own posts.");
		}
		const auto = kind === "invite";
		if (!auto) {
			const [pending] = await tx`select 1 from money_shop_orders where user_id = ${userId}::bigint and item_id = ${itemId}::bigint and status = 'pending'`;
			if (pending) throw new ShopError("You already have a request for this item waiting for approval.");
		}
		const [wallet] = await tx`select balance_cents from money_wallets where user_id = ${userId}::bigint for update`;
		const price = Number(item.price);
		if (Number(wallet.balance_cents) < price) throw new ShopError("You don't have enough money for that.");
		await tx`update money_wallets set balance_cents = balance_cents - ${price} where user_id = ${userId}::bigint`;
		if (auto) payload.code = await createInvite({ createdBy: userId, maxUses: 1, expiresAt: new Date(Date.now() + INVITE_DAYS * 86400e3) }, tx);
		const id = newId();
		await tx`insert into money_shop_orders (id, user_id, item_id, item_name, price_cents, kind, payload, recipient_id, days, status, reviewed_at)
			values (${id}::bigint, ${userId}::bigint, ${itemId}::bigint, ${item.name}, ${price}, ${kind}, ${JSON.stringify(payload)}::text::jsonb,
				${recipientId}::bigint, ${item.days ?? null}, ${auto ? "approved" : "pending"}, ${auto ? new Date() : null})`;
		for (const [position, f] of files.entries())
			await tx`insert into money_shop_order_files (order_id, position, name, image, mime) values (${id}::bigint, ${position}, ${f.name}, ${f.image}, ${f.mime})`;
		return { id, name: item.name, auto };
	});
}

// A shop checkmark ends when its days are up. One staff gave (Admin > the
// account) has no end and isn't touched: setting a badge there clears the end.
export async function expireShopCheckmarks() {
	await sql`update users set verified_type = null, verified_at = null, shop_verified_until = null
		where shop_verified_until is not null and shop_verified_until < now()`;
}

export async function myShopOrders(userId: string) {
	return sql`select o.id::text, o.item_name, o.price_cents::bigint as price, o.kind, o.status, o.created_at,
		case when o.kind = 'invite' then o.payload->>'code' end as code, r.screen_name as gift_to
		from money_shop_orders o left join users r on r.id = o.recipient_id where o.user_id = ${userId}::bigint order by o.id desc limit 20`;
}

const DESCRIPTION: Record<string, string> = {
	badge: "A badge for your profile.",
	custom_badge: "Your own badge design on your profile.",
	announcement: "An announcement for everyone on the instance.",
	checkmark: "A blue checkmark, with longer posts while it lasts.",
	invite: "A code that lets one person sign up here.",
	hashflag: "Your own emoji after a hashtag, everywhere it's posted.",
	sticker_pack: "Your own stickers in everyone's composer.",
	explore_card: "Your story at the top of Explore.",
	boost: "One of your posts in more people's For you, marked as an ad.",
};

export async function shopView(items: any[], orders: any[], balance: number, error = "", notice = "") {
	const price = (c: number | bigint) => `$${(Number(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
	const days = (n: number) => `${n} day${n === 1 ? "" : "s"}`;
	const activeItems = items.filter((i) => i.active);
	const products = activeItems.map((i) => {
		const remote = Boolean(i.remote_origin);
		const id = esc(i.id);
		const field = (name: string, label: string, attrs: string) =>
			`<label for="${name}-${id}">${label}</label><input id="${name}-${id}" name="${name}" ${attrs}>`;
		const upload = (name: string, label: string, accept: string, hint: string, extra = "required") =>
			`<label>${label}</label><div class="shop-upload"><input class="shop-file-input" id="${name}-${id}" name="${name}" type="file" accept="${accept}" ${extra}><label for="${name}-${id}"><span>Choose ${extra.includes("multiple") ? "images" : "image"}</span><span class="shop-upload-name" data-file-name>No image chosen</span></label></div><span class="shop-hint">${hint}</span>`;
		const gift = GIFTS.has(i.kind) ? field("gift", "Gift to (optional)", `maxlength="16" autocapitalize="off" placeholder="@username"`) : "";
		const send = (label = "Send for review") => `<input type="hidden" name="item" value="${id}"><button class="pill primary" type="submit">${label}</button>`;
		const multipart = `method="post" enctype="multipart/form-data" class="shop-form"`;
		const fields: Record<string, string> = {
			announcement: `<form method="post" class="shop-form"><label for="shop-text-${id}">Announcement text</label><textarea id="shop-text-${id}" name="text" maxlength="500" required placeholder="What should the announcement say?"></textarea>${field("link", "Optional link", `type="url" maxlength="500" placeholder="https://example.com"`)}${send()}</form>`,
			custom_badge: `<form ${multipart}>${field("badgeName", "Badge name", `maxlength="60" required placeholder="Name your badge"`)}${upload("badgeImage", "Badge image", BADGE_TYPES.join(","), "PNG, JPEG, WebP or GIF, up to 256 KB and 1024 × 1024")}${gift}${send()}</form>`,
			badge: `<form method="post" class="shop-form">${gift}${send("Get this badge")}</form>`,
			checkmark: `<form method="post" class="shop-form">${gift}${send()}</form>`,
			invite: `<form method="post" class="shop-form"><span class="shop-hint">Comes at once. It works for one sign-up within ${INVITE_DAYS} days.</span>${send("Get a code")}</form>`,
			hashflag: `<form ${multipart}>${field("hashtag", "Hashtag", `maxlength="101" required autocapitalize="off" placeholder="#yourtag"`)}${upload("emoji", "Emoji", "image/png,image/gif,image/webp", "PNG, GIF or WebP, up to 256 KB and 512 × 512")}${send()}</form>`,
			sticker_pack: `<form ${multipart}>${field("packName", "Pack name", `maxlength="40" required placeholder="Name your pack"`)}${upload("stickers", "Stickers", "image/png,image/gif,image/webp", `Up to ${MAX_STICKERS}: PNG, GIF or WebP, up to 512 KB and 1024 × 1024 each`, "required multiple")}${send()}</form>`,
			explore_card: `<form ${multipart}>${field("title", "Title", `maxlength="100" required placeholder="What's happening"`)}<label for="summary-${id}">Summary</label><textarea id="summary-${id}" name="summary" maxlength="280" placeholder="A line or two about it"></textarea>${field("query", "Opens a search for", `maxlength="200" required placeholder="#yourtag"`)}${upload("picture", "Picture (optional)", "image/png,image/jpeg,image/webp", "PNG, JPEG or WebP, up to 1 MB", "")}${send()}</form>`,
			boost: `<form method="post" class="shop-form">${field("post", "Your post", `type="url" required placeholder="https://x.com/you/status/…"`)}${send()}</form>`,
		};
		const form = remote ? `<p class="shop-remote">Listed on ${esc(i.remote_origin)}. Buying from other instances isn’t available yet.</p>` : fields[i.kind] ?? "";
		const image = i.kind === "badge" ? (remote && i.badge_url
			? `<img class="shop-badge-preview" src="${esc(i.badge_url)}" alt="${esc(i.badge_name || i.name)}">`
			: i.badge_id ? `<img class="shop-badge-preview" src="/public/badge-${esc(i.badge_id)}.png" alt="${esc(i.badge_name || i.name)}">` : "") : "";
		const kind = (KIND_LABEL[i.kind] ?? i.kind) + (i.days ? ` · ${days(i.days)}` : "");
		return `<article class="shop-item"><div>${image}<h3>${esc(i.name)}</h3><p class="shop-item-description">${esc(i.description || DESCRIPTION[i.kind] || "")}</p><div class="shop-meta"><strong class="shop-price">${price(i.price)}</strong><span class="shop-kind">${esc(kind)}</span></div></div>${form}</article>`;
	}).join("");
	const states: Record<string, string> = { pending: "Pending review", approved: "Approved", rejected: "Declined · refunded" };
	const order = (o: any) => {
		const status = o.kind === "invite" ? "Ready" : states[o.status] ?? o.status;
		const extra = o.code
			? `<div class="order-status">Code <b>${esc(o.code)}</b> · <a href="/signup?code=${encodeURIComponent(o.code)}" target="_blank">sign-up link</a></div>`
			: o.gift_to ? `<div class="order-status">A gift for @${esc(o.gift_to)}</div>` : "";
		return `<div class="order"><div class="order-name">${esc(o.item_name)}</div><b class="order-price">${price(o.price)}</b><div class="order-status ${esc(o.status)}">${esc(status)} · ${new Date(o.created_at).toLocaleDateString()}</div>${extra}</div>`;
	};
	const history = orders.length ? `<section class="shop-history"><h2>Your requests</h2><div>${orders.map(order).join("")}</div></section>` : "";
	return `<section class="hero shop-hero" aria-label="Balance"><div class="label">Balance</div><div class="amount">${price(balance)}</div><p class="dim">Staff review every request. Declined requests are refunded.</p></section>
	${notice ? `<div class="notice" role="status">${esc(notice)}</div>` : ""}${error ? `<div class="notice error" role="alert">${esc(error)}</div>` : ""}<div class="shop-page"><h2>Items</h2>${activeItems.length ? `<div class="shop-grid">${products}</div>` : `<p class="empty">Nothing in the shop right now.</p>`}${history}</div>`;
}
