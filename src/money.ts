// X Money: every account has a wallet and sends money to other accounts on
// this instance, asks for it (a request of one account, or a "Pay @name" card
// anyone can pay) and earns it from likes on its posts. It is the instance's
// own play money: a new wallet starts with the instance's starting balance
// (settings.ts money), and admins add more. Nothing is paid in or out.
// The pages are money-page.ts; the client's side is money-ui.ts.

import { audit } from "./admin";
import { esc } from "./account-page";
import type { Viewer } from "./auth";
import { isBlockedEitherWay } from "./blocks";
import { PUBLIC_ORIGIN } from "./config";
import { sql } from "./db";
import { hateIn } from "./hate";
import { newId } from "./ids";
import { linksIn } from "./links";
import { absolute } from "./media";
import { avatarUrl } from "./model";
import { feature, hasBlockedPhrase, settings } from "./settings";
import { MONEY_ICON } from "./tidy";

export const NOTE_MAX = 140;
// a requester's requests of other accounts still waiting at once
const OPEN_REQUESTS_MAX = 20;

export class MoneyError extends Error {}

// "$12.50", "12.5" or "12" in cents; null when it isn't an amount
export function parseAmount(text: string): number | null {
	const m = /^\$?\s*(\d{1,9})(?:\.(\d{1,2}))?$/.exec(text.trim().replace(/,/g, ""));
	if (!m) return null;
	return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}

export const formatCents = (cents: number | bigint) => {
	const n = Number(cents);
	const dollars = Math.floor(n / 100).toLocaleString("en-US");
	return `$${dollars}.${String(n % 100).padStart(2, "0")}`;
};
// whole amounts without their cents, as X shows them ("$100", "$3.52")
export const shortCents = (cents: number) => (cents % 100 ? formatCents(cents) : `$${(cents / 100).toLocaleString("en-US")}`);

export const date = (d: Date) => new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", ...(new Date(d).getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}) });

// the wallet's row, made with the starting balance the first time
async function ensureWallet(userId: string, db: typeof sql = sql) {
	await db`insert into money_wallets (user_id, balance_cents) values (${userId}::bigint, ${settings().money.starting_cents})
		on conflict (user_id) do nothing`;
}

export async function balanceOf(userId: string): Promise<number> {
	await ensureWallet(userId);
	const [w] = await sql`select balance_cents from money_wallets where user_id = ${userId}::bigint`;
	return Number(w.balance_cents);
}

// what an account accepts before Money opens, on the page and through the API
export const disclaimerText = () => {
	const instance = settings().instance_name, name = `${instance} Money`;
	return `${name} is a virtual currency used solely within the ${instance} platform. It has no real-world monetary value, is not legal tender, and cannot be exchanged for real money, cryptocurrency, or other monetary assets. ${name} is for entertainment and platform use only.`;
};

// the disclaimer, accepted once per account before Money opens (money-page.ts)
export async function disclaimerAccepted(userId: string): Promise<boolean> {
	await ensureWallet(userId);
	const [w] = await sql`select disclaimer_at is not null as ok from money_wallets where user_id = ${userId}::bigint`;
	return !!w?.ok;
}
export async function acceptDisclaimer(userId: string) {
	await ensureWallet(userId);
	await sql`update money_wallets set disclaimer_at = coalesce(disclaimer_at, now()) where user_id = ${userId}::bigint`;
}

// local, usable accounts only: money stays on this instance
export async function accountFor(handle: string) {
	const name = handle.trim().replace(/^@/, "");
	if (!/^[A-Za-z0-9_]{1,15}$/.test(name)) return null;
	const [u] = await sql`select id::text, screen_name, name from users
		where lower(screen_name) = lower(${name}) and instance is null and status <> 'suspended' and deactivated_at is null`;
	return u ?? null;
}

function checkNote(note: string) {
	note = note.trim();
	if ([...note].length > NOTE_MAX) throw new MoneyError(`Notes are up to ${NOTE_MAX} characters.`);
	if (note && (hateIn(note) || hasBlockedPhrase(note))) throw new MoneyError("That note can't be sent.");
	return note;
}

// Moves the money in one transaction. Both wallets are locked in id order, so
// two people paying each other at once can't deadlock. A repeated `idem`
// returns the transfer it already made. Paying a request checks it is still
// open, for this payer, to its requester, for its amount.
export async function sendMoney(senderId: string, handle: string, amountCents: number, note: string, idem: string, requestId?: string): Promise<{ id: string; to: string; repeated: boolean }> {
	if (!Number.isSafeInteger(amountCents) || amountCents <= 0) throw new MoneyError("Enter an amount over $0.");
	const max = settings().money.max_transfer_cents;
	if (amountCents > max) throw new MoneyError(`You can send up to ${formatCents(max)} at a time.`);
	note = checkNote(note);
	if (!/^[\w-]{8,64}$/.test(idem)) throw new MoneyError("The form expired. Try again.");
	if (requestId !== undefined && !/^\d{1,19}$/.test(requestId)) throw new MoneyError("That request doesn't exist.");
	const to = await accountFor(handle);
	if (!to) throw new MoneyError("There's no account here with that username.");
	if (to.id === senderId) throw new MoneyError("You can't send money to yourself.");
	if (await isBlockedEitherWay(senderId, to.id)) throw new MoneyError(`You can't send money to @${to.screen_name}.`);
	return sql.begin(async (tx) => {
		const [done] = await tx`select id from money_transfers where sender_id = ${senderId}::bigint and idem = ${idem}`;
		if (done) return { id: String(done.id), to: to.screen_name, repeated: true };
		if (requestId) {
			const [rq] = await tx`select requester_id::text, payer_id::text, amount_cents, status from money_requests where id = ${requestId}::bigint for update`;
			if (!rq || rq.status !== "open" || rq.requester_id !== to.id || (rq.payer_id && rq.payer_id !== senderId)) throw new MoneyError("That request isn't open to you any more.");
			if (rq.amount_cents && Number(rq.amount_cents) !== amountCents) throw new MoneyError(`That request is for ${formatCents(Number(rq.amount_cents))}.`);
			if (rq.payer_id) await tx`update money_requests set status = 'paid', resolved_at = now() where id = ${requestId}::bigint`;
		}
		await ensureWallet(senderId, tx);
		await ensureWallet(to.id, tx);
		const wallets = await tx`select user_id::text, balance_cents from money_wallets
			where user_id in (${senderId}::bigint, ${to.id}::bigint) order by user_id for update`;
		// a second press of Send waited here for the first: it finds what that made
		const [made] = await tx`select id from money_transfers where sender_id = ${senderId}::bigint and idem = ${idem}`;
		if (made) return { id: String(made.id), to: to.screen_name, repeated: true };
		const mine = wallets.find((w: any) => w.user_id === senderId);
		if (Number(mine.balance_cents) < amountCents) throw new MoneyError("You don't have enough money for that.");
		const id = newId();
		await tx`update money_wallets set balance_cents = balance_cents - ${amountCents} where user_id = ${senderId}::bigint`;
		await tx`update money_wallets set balance_cents = balance_cents + ${amountCents} where user_id = ${to.id}::bigint`;
		await tx`insert into money_transfers (id, sender_id, recipient_id, amount_cents, note, idem, request_id)
			values (${id}::bigint, ${senderId}::bigint, ${to.id}::bigint, ${amountCents}, ${note}, ${idem}, ${requestId ?? null})`;
		return { id, to: to.screen_name, repeated: false };
	});
}

// Asks for money: of one account (it gets a notification, and pays or
// declines), or of anyone when `from` is empty (a "Pay @name" card, with or
// without an amount).
export async function requestMoney(requesterId: string, from: string, amountText: string, note: string): Promise<string> {
	const [me] = await sql`select status from users where id = ${requesterId}::bigint`;
	if (me?.status === "restricted") throw new MoneyError("Your account can't ask for money right now.");
	note = checkNote(note);
	const amount = amountText.trim() ? parseAmount(amountText) : null;
	if (amountText.trim() && !amount) throw new MoneyError("Enter an amount, like 5 or 12.50.");
	if (amount && amount > settings().money.max_transfer_cents) throw new MoneyError(`You can ask for up to ${formatCents(settings().money.max_transfer_cents)} at a time.`);
	let payer: { id: string; screen_name: string } | null = null;
	if (from.trim()) {
		payer = await accountFor(from);
		if (!payer) throw new MoneyError("There's no account here with that username.");
		if (payer.id === requesterId) throw new MoneyError("You can't ask yourself for money.");
		if (!amount) throw new MoneyError(`Say how much you're asking @${payer.screen_name} for.`);
		if (await isBlockedEitherWay(requesterId, payer.id)) throw new MoneyError(`You can't ask @${payer.screen_name} for money.`);
		const [{ n }] = await sql`select count(*)::int as n from money_requests where requester_id = ${requesterId}::bigint and payer_id is not null and status = 'open'`;
		if (n >= OPEN_REQUESTS_MAX) throw new MoneyError(`You have ${n} requests waiting. Cancel some first.`);
		const [dup] = await sql`select id::text from money_requests where requester_id = ${requesterId}::bigint and payer_id = ${payer.id}::bigint and status = 'open'
			and amount_cents = ${amount} and note = ${note}`;
		if (dup) return dup.id;
	} else {
		// one plain "Pay me" card each: asking again gives the same one
		const [same] = await sql`select id::text from money_requests where requester_id = ${requesterId}::bigint and payer_id is null and status = 'open'
			and amount_cents is not distinct from ${amount} and note = ${note}`;
		if (same) return same.id;
	}
	const id = newId();
	await sql`insert into money_requests (id, requester_id, payer_id, amount_cents, note) values (${id}::bigint, ${requesterId}::bigint, ${payer?.id ?? null}, ${amount}, ${note})`;
	return id;
}

// the payer declines a request of them, the requester cancels their own
export async function closeRequest(viewerId: string, id: string, action: "decline" | "cancel"): Promise<boolean> {
	const rows =
		action === "decline"
			? await sql`update money_requests set status = 'declined', resolved_at = now() where id = ${id}::bigint and payer_id = ${viewerId}::bigint and status = 'open' returning 1`
			: await sql`update money_requests set status = 'cancelled', resolved_at = now() where id = ${id}::bigint and requester_id = ${viewerId}::bigint and status = 'open' returning 1`;
	return rows.length > 0;
}

// staff adding to an account's balance (or taking from it, never below zero)
export async function adjust(viewer: Viewer, handle: string, cents: number) {
	const to = await accountFor(handle);
	if (!to) throw new MoneyError("There's no account here with that username.");
	await ensureWallet(to.id);
	const [w] = await sql`update money_wallets set balance_cents = greatest(balance_cents + ${cents}, 0)
		where user_id = ${to.id}::bigint returning balance_cents`;
	await audit(viewer, "money_adjust", to.id, { cents, balance: Number(w.balance_cents) });
	return { to: to.screen_name, balance: Number(w.balance_cents) };
}

// A like on a local post earns its author money.like_cents, once per post and
// account: unliking and liking again pays nothing more. Likes on your own posts
// and from suspended accounts don't count.
export async function rewardLike(likerId: string, postId: string) {
	const cents = settings().money.like_cents;
	if (!feature("money") || !(cents > 0)) return;
	await sql.begin(async (tx) => {
		const [p] = await tx`select p.user_id::text as author from posts p join users a on a.id = p.user_id
			join users l on l.id = ${likerId}::bigint
			where p.id = ${postId}::bigint and a.instance is null and l.instance is null and l.status <> 'suspended'`;
		if (!p || p.author === likerId) return;
		const paid = await tx`insert into money_like_rewards (post_id, liker_id, author_id, cents) values (${postId}::bigint, ${likerId}::bigint, ${p.author}::bigint, ${cents})
			on conflict do nothing returning 1`;
		if (!paid.length) return;
		await ensureWallet(p.author, tx);
		await tx`update money_wallets set balance_cents = balance_cents + ${cents} where user_id = ${p.author}::bigint`;
	});
}

// Merchant mode (Settings > X Money): for gold organisations, payments to them
// read as purchases, with the name they choose and, if they like, their banner
export async function merchantOf(userId: string) {
	const [m] = await sql`select u.verified_type = 'business' as gold, m.user_id is not null as on, coalesce(m.name, '') as name, coalesce(m.show_banner, true) as show_banner
		from users u left join money_merchants m on m.user_id = u.id where u.id = ${userId}::bigint`;
	return { gold: !!m?.gold, on: !!m?.on, name: (m?.name as string) ?? "", showBanner: (m?.show_banner as boolean) ?? true };
}
export async function setMerchant(userId: string, on: boolean, name: string, showBanner: boolean) {
	if (!on) return void (await sql`delete from money_merchants where user_id = ${userId}::bigint`);
	name = name.trim();
	if ([...name].length > 50) throw new MoneyError("Merchant names are up to 50 characters.");
	if (name && (hateIn(name) || hasBlockedPhrase(name))) throw new MoneyError("That name can't be used.");
	await sql`insert into money_merchants (user_id, name, show_banner) values (${userId}::bigint, ${name}, ${showBanner})
		on conflict (user_id) do update set name = excluded.name, show_banner = excluded.show_banner, updated_at = now()`;
}

// ---- who a payment involves, as cards and lists show them

export type Party = {
	id: string;
	screen_name: string;
	name: string;
	avatar: string;
	// X's checkmark: the account's own, or blue for an organisation's affiliate
	badge: string | null;
	// the organisation an affiliate wears after its name
	org: { name: string; screen_name: string; avatar: string } | null;
	// organisations have square pictures
	square: boolean;
	// set while merchant mode is on: the name purchases read and the banner they show
	merchant: { name: string; banner: string | null } | null;
};

// an address that can sit inside a style's url("...") as it is
const plainUrl = (u: string | null) => (u && /^(https?:\/\/|\/)[^\s"'()\\<>]+$/.test(u) ? u : null);

export async function parties(ids: string[]): Promise<Map<string, Party>> {
	if (!ids.length) return new Map();
	const rows = await sql`select u.id::text, u.screen_name, u.name, u.avatar_url, u.banner_url, u.verified_type,
			(select json_build_object('name', o.name, 'screen_name', o.screen_name, 'avatar', o.avatar_url) from affiliations af join users o on o.id = af.org_id
				where af.user_id = u.id order by af.created_at, af.org_id limit 1) as org,
			m.user_id is not null and u.verified_type = 'business' as merchant, m.name as m_name, m.show_banner
		from users u left join money_merchants m on m.user_id = u.id where u.id = any(${sql.array([...new Set(ids)], "INT8")})`;
	return new Map(
		rows.map((r: any) => [
			r.id,
			{
				id: r.id,
				screen_name: r.screen_name,
				name: r.name || r.screen_name,
				avatar: avatarUrl(r.avatar_url),
				badge: r.verified_type ?? (r.org ? "blue" : null),
				org: r.org ? { name: r.org.name, screen_name: r.org.screen_name, avatar: avatarUrl(r.org.avatar) } : null,
				square: r.verified_type === "business" || r.verified_type === "government",
				merchant: r.merchant ? { name: r.m_name || r.name || r.screen_name, banner: r.show_banner && r.banner_url ? plainUrl(absolute(r.banner_url)) : null } : null,
			} satisfies Party,
		]),
	);
}

// X's verified badge, in the account's colour, and an affiliate's organisation after it
const BADGE_PATH = "M22.25 12c0-1.43-.88-2.67-2.19-3.34.46-1.39.2-2.9-.81-3.91s-2.52-1.27-3.91-.81c-.66-1.31-1.91-2.19-3.34-2.19s-2.67.88-3.33 2.19c-1.4-.46-2.91-.2-3.92.81s-1.26 2.52-.8 3.91c-1.31.67-2.2 1.91-2.2 3.34s.89 2.67 2.2 3.34c-.46 1.39-.21 2.9.8 3.91s2.52 1.26 3.91.81c.67 1.31 1.91 2.19 3.34 2.19s2.68-.88 3.34-2.19c1.39.45 2.9.2 3.91-.81s1.27-2.52.81-3.91c1.31-.67 2.19-1.91 2.19-3.34zm-11.71 4.2L6.8 12.46l1.41-1.42 2.26 2.26 4.8-5.23 1.47 1.36-6.2 6.77z";
const BADGE_COLOR: Record<string, string> = { blue: "#1d9bf0", business: "#e2b719", government: "#829aab", government_individual: "#829aab" };
const BADGE_LABEL: Record<string, string> = { blue: "Verified account", business: "Verified organisation", government: "Government organisation", government_individual: "Government official" };
export const badges = (p: Pick<Party, "badge" | "org">) =>
	(p.badge && BADGE_COLOR[p.badge] ? `<svg class="xm-badge" viewBox="0 0 22 22" role="img" aria-label="${BADGE_LABEL[p.badge]}"><path fill="${BADGE_COLOR[p.badge]}" d="${BADGE_PATH}"/></svg>` : "") +
	(p.org ? `<img class="xm-org" src="${esc(p.org.avatar)}" alt="${esc(p.org.name)}" title="${esc(p.org.name)}">` : "");
export const face = (p: Party, cls = "") => `<img class="${cls}${p.square ? " xm-sq" : ""}" src="${esc(p.avatar)}" alt="">`;
// "with [$] Money", where X writes "with my X Card"
export const MONEY_WORDMARK = `<span class="xm-mark"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${MONEY_ICON}"/></svg>Money</span>`;

// ---- payments

// reversed: staff sent the money back (Admin > Money)
export type Payment = { id: string; amount: number; note: string; at: Date; sender: Party; recipient: Party; reversed?: boolean };

// payments by id, with both sides; `visibleTo` keeps the ones that account is
// part of or that one side put in a post
export async function payments(ids: string[], visibleTo?: string): Promise<Map<string, Payment>> {
	if (!ids.length) return new Map();
	const rows = await sql`select t.id::text, t.amount_cents, t.note, t.created_at, t.sender_id::text, t.recipient_id::text, t.reversed_at is not null as reversed from money_transfers t
		where t.id = any(${sql.array(ids, "INT8")})
		${
			visibleTo
				? sql`and (${visibleTo}::bigint in (t.sender_id, t.recipient_id) or exists (select 1 from posts p
				where p.user_id in (t.sender_id, t.recipient_id) and p.text ~ ('/i/xmoney/p/' || t.id::text || '([^0-9]|$)')))`
				: sql``
		}`;
	const who = await parties(rows.flatMap((r: any) => [r.sender_id, r.recipient_id]));
	return new Map(
		rows
			.filter((r: any) => who.has(r.sender_id) && who.has(r.recipient_id))
			.map((r: any) => [r.id, { id: r.id, amount: Number(r.amount_cents), note: r.note, at: new Date(r.created_at), sender: who.get(r.sender_id)!, recipient: who.get(r.recipient_id)!, reversed: r.reversed }]),
	);
}

// ---- requests

export type Request = { id: string; amount: number | null; note: string; status: string; at: Date; requester: Party; payer: Party | null; paidCount: number; paidCents: number };

// requests by id; `visibleTo` keeps the ones of anyone, the ones that account
// is part of, and the ones its requester put in a post
export async function requests(ids: string[], visibleTo?: string): Promise<Map<string, Request>> {
	if (!ids.length) return new Map();
	const rows = await sql`select q.id::text, q.amount_cents, q.note, q.status, q.created_at, q.requester_id::text, q.payer_id::text,
			(select count(*)::int from money_transfers t where t.request_id = q.id) as paid_count,
			(select coalesce(sum(amount_cents), 0)::bigint from money_transfers t where t.request_id = q.id) as paid_cents
		from money_requests q where q.id = any(${sql.array(ids, "INT8")})
		${
			visibleTo
				? sql`and (q.payer_id is null or ${visibleTo}::bigint in (q.requester_id, q.payer_id) or exists (select 1 from posts p
				where p.user_id = q.requester_id and p.text ~ ('/i/xmoney/r/' || q.id::text || '([^0-9]|$)')))`
				: sql``
		}`;
	const who = await parties(rows.flatMap((r: any) => [r.requester_id, ...(r.payer_id ? [r.payer_id] : [])]));
	return new Map(
		rows
			.filter((r: any) => who.has(r.requester_id))
			.map((r: any) => [
				r.id,
				{
					id: r.id,
					amount: r.amount_cents ? Number(r.amount_cents) : null,
					note: r.note,
					status: r.status,
					at: new Date(r.created_at),
					requester: who.get(r.requester_id)!,
					payer: r.payer_id ? (who.get(r.payer_id) ?? null) : null,
					paidCount: r.paid_count,
					paidCents: Number(r.paid_cents),
				},
			]),
	);
}

// ---- addresses and cards

export const paymentUrl = (id: string) => `${PUBLIC_ORIGIN}/i/xmoney/p/${id}`;
export const requestUrl = (id: string) => `${PUBLIC_ORIGIN}/i/xmoney/r/${id}`;
const OWN_HOST = new URL(PUBLIC_ORIGIN).host;
const MONEY_PATH = /^\/i\/xmoney\/([pr])\/(\d{1,19})\/?$/;
// "p<id>" for a payment's address, "r<id>" for a request's
export function moneyKeyOf(url: string): string | undefined {
	try {
		const u = new URL(url);
		const m = u.host === OWN_HOST ? MONEY_PATH.exec(u.pathname) : null;
		return m ? m[1] + m[2] : undefined;
	} catch {
		return undefined;
	}
}

// The card as X draws a payment in a post: a person paid shows the amount, both
// faces and the note; a merchant is a purchase, with its banner and logo when
// it shows a banner. `by` is the handle of the account the card speaks for.
// The card leads to the account that was paid.
export function paymentCard(t: Payment, by: string) {
	const go = `data-xm-go="/${esc(t.recipient.screen_name)}"`;
	const r = t.recipient;
	if (r.merchant) {
		const name = `<span class="xm-who"><b>${esc(r.merchant.name)}</b>${badges(r)}</span>`;
		if (r.merchant.banner)
			return `<div class="xm-card xm-shop" role="link" tabindex="0" ${go}><div class="xm-banner" style="background-image:url(&quot;${esc(r.merchant.banner)}&quot;)"></div>
<div class="xm-body">${face(r, "xm-logo")}<div class="xm-row">${name}<span class="xm-dim">${date(t.at)}</span></div>
<div class="xm-rule"></div><div class="xm-amt">${shortCents(t.amount)}</div><div class="xm-dim">with ${MONEY_WORDMARK}</div></div></div>`;
		return `<div class="xm-card xm-buy" role="link" tabindex="0" ${go}>${face(r, "xm-logo")}
<div class="xm-grow"><div class="xm-line"><b>${shortCents(t.amount)}</b> <span class="xm-dim">at</span> ${name}</div><div class="xm-dim">with ${MONEY_WORDMARK}</div></div><span class="xm-dim xm-end">${date(t.at)}</span></div>`;
	}
	const sent = by !== r.screen_name.toLowerCase();
	const other = sent ? r : t.sender;
	return `<div class="xm-card xm-p2p" role="link" tabindex="0" ${go}><div class="xm-row"><div class="xm-amt">${shortCents(t.amount)}</div>
<div class="xm-faces">${face(t.sender)}${face(r)}</div></div>
<div class="xm-line"><span class="xm-dim">${sent ? "sent to" : "from"}</span> <span class="xm-who"><b>${esc(other.name)}</b>${badges(other)}</span></div>
<div class="xm-row">${t.note ? `<span class="xm-dim xm-note">"${esc(t.note)}"</span>` : "<span></span>"}<span class="xm-dim">${date(t.at)}</span></div></div>`;
}

// A request in a post, as X's "Pay @name" card: who to pay, with Money, and a
// Pay button while it's open. A request of one account names both. The Pay
// button pays it, for whoever may; for anyone else (its own requester, say)
// it opens the request. The card leads to the account to pay.
export function requestCard(q: Request, viewerId: string) {
	const r = q.requester;
	const payable = r.id !== viewerId && (!q.payer || q.payer.id === viewerId);
	const to = payable ? `/account/money/send?request=${q.id}` : `/account/money/r/${q.id}`;
	// with Money switched off the card stays, without a way to pay
	const button = !feature("money")
		? ""
		: q.status === "open"
			? `<a class="xm-pay" href="${to}" data-xm-go="${to}">Pay</a>`
			: `<span class="xm-state">${q.status === "paid" ? "Paid" : q.status === "declined" ? "Declined" : "Closed"}</span>`;
	const who = r.merchant ? esc(r.merchant.name) : `@${esc(r.screen_name)}`;
	const line = q.payer
		? `<b>${who}</b>${badges(r)} <span class="xm-dim">requested</span> <b>${q.amount ? shortCents(q.amount) : ""}</b>`
		: `<b>Pay ${who}</b>${badges(r)}${q.amount ? ` <span class="xm-dim">·</span> <b>${shortCents(q.amount)}</b>` : ""}`;
	const sub = q.payer ? `from @${esc(q.payer.screen_name)}${q.note ? ` · ${esc(q.note)}` : ""}` : q.note ? esc(q.note) : `with ${MONEY_WORDMARK}`;
	return `<div class="xm-card xm-req" role="link" tabindex="0" data-xm-go="/${esc(r.screen_name)}">${r.merchant ? face(r, "xm-logo") : ""}
<div class="xm-grow"><div class="xm-line">${line}</div><div class="xm-dim xm-sub">${sub}</div></div>${button}</div>`;
}

// Posts carrying one of their own payments' or requests' links get its card.
// The card is X's plain summary card, which the client script draws over.
export async function paymentCards(posts: { authorId: string; text: string }[]): Promise<(Record<string, unknown> | undefined)[]> {
	const wanted = posts.map((p, index) => ({ ...p, index, key: linksIn(p.text).map((l) => moneyKeyOf(l.url)).find((k) => !!k) })).filter((p) => p.key);
	const ids = (kind: string) => [...new Set(wanted.filter((p) => p.key![0] === kind).map((p) => p.key!.slice(1)))];
	const [paid, asked] = await Promise.all([payments(ids("p")), requests(ids("r"))]);
	const out: (Record<string, unknown> | undefined)[] = posts.map(() => undefined);
	for (const p of wanted) {
		const id = p.key!.slice(1);
		let title: string, description: string, image: string, url: string;
		if (p.key![0] === "p") {
			const t = paid.get(id);
			if (!t || (p.authorId !== t.sender.id && p.authorId !== t.recipient.id)) continue;
			const mine = p.authorId === t.sender.id;
			title = t.recipient.merchant ? `${shortCents(t.amount)} at ${t.recipient.merchant.name}` : mine ? `${shortCents(t.amount)} sent to ${t.recipient.name}` : `${shortCents(t.amount)} from ${t.sender.name}`;
			description = t.note ? `“${t.note}”` : `${settings().instance_name} Money · ${date(t.at)}`;
			image = mine ? t.recipient.avatar : t.sender.avatar;
			url = paymentUrl(id);
		} else {
			const q = asked.get(id);
			if (!q || p.authorId !== q.requester.id) continue;
			title = `Pay ${q.requester.merchant ? q.requester.merchant.name : `@${q.requester.screen_name}`}${q.amount ? ` ${shortCents(q.amount)}` : ""}`;
			description = q.note || `with ${settings().instance_name} Money`;
			image = q.requester.avatar;
			url = requestUrl(id);
		}
		const str = (v: string) => ({ string_value: v, type: "STRING" });
		const img = { image_value: { url: image, width: 400, height: 400, alt: null }, type: "IMAGE" };
		const values: Record<string, unknown> = {
			title: str(title),
			description: str(description),
			domain: str(OWN_HOST),
			vanity_url: { ...str(OWN_HOST), scribe_key: "vanity_url" },
			card_url: { ...str(url), scribe_key: "card_url" },
			thumbnail_image: img,
			thumbnail_image_large: img,
			thumbnail_image_original: img,
		};
		out[p.index] = {
			rest_id: url,
			legacy: {
				binding_values: Object.entries(values).map(([key, value]) => ({ key, value })),
				card_platform: { platform: { audience: { name: "production" }, device: { name: "Swift", version: "12" } } },
				name: "summary",
				url,
				user_refs_results: [],
			},
		};
	}
	return out;
}

// ---- the client's calls (/i/api/xitter/money/...)

// GET cards?ids=p1,r2&by=<handle>: the cards the viewer may see, as HTML;
// with preview=1, a request's as others see it (the composer's mockup)
export async function cardsApi(viewer: Viewer, url: URL): Promise<Response> {
	const keys = (url.searchParams.get("ids") ?? "").split(",").filter((k) => /^[pr]\d{1,19}$/.test(k)).slice(0, 40);
	const by = (url.searchParams.get("by") ?? "").toLowerCase();
	const [paid, asked] = await Promise.all([
		payments(keys.filter((k) => k[0] === "p").map((k) => k.slice(1)), viewer.id),
		requests(keys.filter((k) => k[0] === "r").map((k) => k.slice(1)), viewer.id),
	]);
	const out: Record<string, string> = {};
	for (const [id, t] of paid) out[`p${id}`] = paymentCard(t, by);
	const preview = url.searchParams.has("preview");
	for (const [id, q] of asked) out[`r${id}`] = requestCard(q, preview ? "" : viewer.id);
	return Response.json(out, { headers: { "cache-control": "private, no-store" } });
}

// GET recent: the viewer's latest payments for the composer's picker
export async function recentApi(viewer: Viewer): Promise<Response> {
	if (!feature("money")) return Response.json([]);
	const rows = await sql`select id::text from money_transfers where sender_id = ${viewer.id}::bigint or recipient_id = ${viewer.id}::bigint order by id desc limit 12`;
	const found = await payments(rows.map((r: any) => r.id));
	return Response.json(
		rows
			.map((r: any) => found.get(r.id))
			.filter((t: Payment | undefined): t is Payment => !!t)
			.map((t: Payment) => {
				const sent = t.sender.id === viewer.id;
				const other = sent ? t.recipient : t.sender;
				return { id: t.id, url: paymentUrl(t.id), amount: shortCents(t.amount), sent, shop: sent && !!other.merchant, name: other.merchant?.name ?? other.name, avatar: other.avatar, note: t.note, date: date(t.at) };
			}),
	);
}

// POST payme: the viewer's plain "Pay @name" card, made the first time
export async function payMeApi(viewer: Viewer): Promise<Response> {
	if (!feature("money") || viewer.actor || viewer.instance) return Response.json({ error: "X Money isn't available." }, { status: 403 });
	return Response.json({ url: requestUrl(await requestMoney(viewer.id, "", "", "")) });
}
