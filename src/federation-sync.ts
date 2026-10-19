import { existsSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "./db";
import { FederationError, INSTANCE_ID, type Incoming, isBlocked, isPeer, peers, signedAnswer, signedFetch, signedRawAnswer } from "./federation";
import { newId } from "./ids";
import { posterFile } from "./video";

const MEDIA_DIR = process.env.MEDIA_DIR ?? "media";
const PAGE = 200;
const EVENTS_PER_HOUR = Number(process.env.FEDERATION_EVENTS_PER_HOUR) || 20_000;
const MAX_ACCOUNTS = Number(process.env.FEDERATION_MAX_ACCOUNTS) || 100_000;
const budgets = new Map<string, { start: number; used: number }>();
const MAX_MEDIA = 64 * 1024 * 1024;
const REF_RE = /^(\d{1,19})@([a-z0-9.:-]{1,260})$/;

const ref = (id: string | number | bigint, instance = INSTANCE_ID) => `${id}@${instance}`;
const parseRef = (value: unknown) => {
	const m = typeof value === "string" ? REF_RE.exec(value) : null;
	return m ? { id: m[1], instance: m[2] } : undefined;
};
const clip = (value: unknown, max: number) => (typeof value === "string" ? value.slice(0, max) : "");
const isLocalMediaPath = (path: string | null, banner = false) => (path ? new RegExp(`^/media/${banner ? "banner/" : ""}(\\d{1,19})$`).exec(path)?.[1] : undefined);

async function canonicalOf(kind: "user" | "post", localId: string): Promise<string | undefined> {
	const table = kind === "user" ? sql`users` : sql`posts`;
	const [row] =
		kind === "user"
			? await sql`select instance, remote_id::text from ${table} where id = ${localId}::bigint`
			: await sql`select u.instance, f.remote_id::text from posts p join users u on u.id = p.user_id
				left join federated_objects f on f.kind = 'post' and f.local_id = p.id where p.id = ${localId}::bigint`;
	if (!row) return undefined;
	if (!row.instance) return ref(localId);
	return row.remote_id ? ref(row.remote_id, row.instance) : undefined;
}

async function renderUser(id: string) {
	const [u] = await sql`select id::text, screen_name, name, bio, location, avatar_url, banner_url, protected, created_at from users
		where id = ${id}::bigint and instance is null and status <> 'suspended' and deactivated_at is null`;
	if (!u) return { kind: "user", id, gone: true };
	return {
		kind: "user",
		id,
		screen_name: u.screen_name,
		name: u.name,
		bio: u.bio,
		location: u.location,
		protected: u.protected,
		created_at: new Date(u.created_at).toISOString(),
		avatar: await renderMedia(isLocalMediaPath(u.avatar_url)),
		banner: await renderMedia(isLocalMediaPath(u.banner_url, true)),
	};
}

async function renderMedia(id: string | undefined) {
	if (!id) return null;
	const [m] = await sql`select id::text, kind, mime, width, height, alt_text, duration_ms from media where id = ${id}::bigint and remote_instance is null`;
	return m ? { id: m.id, kind: m.kind, mime: m.mime, width: m.width, height: m.height, alt_text: m.alt_text ?? null, duration_ms: m.duration_ms ?? null } : null;
}

const publicPost = (id: string) =>
	sql`select p.id::text, p.user_id::text, p.text, p.created_at, p.reply_to_id::text, p.quote_id::text, p.sensitive, p.edited_at from posts p join users u on u.id = p.user_id
		where p.id = ${id}::bigint and u.instance is null and not u.protected and u.status not in ('suspended', 'limited') and u.deactivated_at is null
			and not p.hidden and p.community_id is null and p.article_id is null`;

async function renderPost(id: string) {
	const [p] = await publicPost(id);
	if (!p) return { kind: "post", id, gone: true };
	const media = await sql`select id::text, kind, mime, width, height, alt_text, duration_ms from media where post_id = ${id}::bigint order by position, media.id`;
	return {
		kind: "post",
		id,
		author: p.user_id,
		text: p.text,
		created_at: new Date(p.created_at).toISOString(),
		edited_at: p.edited_at ? new Date(p.edited_at).toISOString() : null,
		sensitive: p.sensitive,
		reply_to: p.reply_to_id ? ((await canonicalOf("post", p.reply_to_id)) ?? null) : null,
		quote: p.quote_id ? ((await canonicalOf("post", p.quote_id)) ?? null) : null,
		media: media.map((m: any) => ({ id: m.id, kind: m.kind, mime: m.mime, width: m.width, height: m.height, alt_text: m.alt_text ?? null, duration_ms: m.duration_ms ?? null })),
	};
}

async function renderPair(kind: "like" | "repost" | "follow", a: string, b: string) {
	if (kind === "follow") {
		const [on] = await sql`select 1 from follows f join users u on u.id = f.followee_id where f.follower_id = ${a}::bigint and f.followee_id = ${b}::bigint and not u.protected`;
		const target = await canonicalOf("user", b);
		return target ? { kind, actor: a, target, on: !!on } : undefined;
	}
	const table = kind === "like" ? sql`likes` : sql`reposts`;
	const [on] = await sql`select 1 from ${table} where user_id = ${a}::bigint and post_id = ${b}::bigint`;
	const target = await canonicalOf("post", b);
	return target ? { kind, actor: a, target, on: !!on } : undefined;
}

async function eventsAfter(after: string, limit: number) {
	const rows = await sql`select seq::text, kind, a::text, b::text from federation_outbox where seq > ${after}::bigint order by federation_outbox.seq limit ${limit}`;
	const events: unknown[] = [];
	for (const r of rows) {
		const rendered = r.kind === "user" ? await renderUser(r.a) : r.kind === "post" ? await renderPost(r.a) : await renderPair(r.kind, r.a, r.b);
		if (rendered) events.push({ seq: r.seq, ...rendered });
	}
	const [{ max }] = await sql`select coalesce(max(seq), 0)::text as max from federation_outbox`;
	return { events, next: rows.length ? rows[rows.length - 1].seq : after, more: rows.length === limit, head: max };
}

async function mediaAllowed(id: string): Promise<boolean> {
	const [m] = await sql`select m.post_id::text, m.user_id::text from media m join users u on u.id = m.user_id
		where m.id = ${id}::bigint and m.remote_instance is null and u.instance is null and u.status <> 'suspended' and u.deactivated_at is null`;
	if (!m) return false;
	if (m.post_id) return (await publicPost(m.post_id)).length > 0;
	const [profile] = await sql`select 1 from users where id = ${m.user_id}::bigint and (avatar_url = ${`/media/${id}`} or banner_url = ${`/media/banner/${id}`})`;
	return !!profile;
}

export async function federationApi(incoming: Incoming, method: string, path: string, url: URL): Promise<Response> {
	if (method === "GET" && path === "/federation/v1/events") {
		const after = /^\d{1,19}$/.test(url.searchParams.get("after") ?? "") ? url.searchParams.get("after")! : "0";
		const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || PAGE, 1), 500);
		return signedAnswer(incoming, 200, await eventsAfter(after, limit));
	}
	const object = /^\/federation\/v1\/objects\/(user|post)\/(\d{1,19})$/.exec(path);
	if (method === "GET" && object) return signedAnswer(incoming, 200, object[1] === "user" ? await renderUser(object[2]) : await renderPost(object[2]));
	const byName = /^\/federation\/v1\/users\/by-name\/(\w{1,50})$/.exec(path);
	if (method === "GET" && byName) {
		const [u] = await sql`select id::text from users where lower(screen_name) = lower(${byName[1]}) and instance is null`;
		return u ? signedAnswer(incoming, 200, await renderUser(u.id)) : signedAnswer(incoming, 404, { error: "No such account." });
	}
	const media = /^\/federation\/v1\/media\/(\d{1,19})(\/poster)?$/.exec(path);
	if (method === "GET" && media) {
		if (!(await mediaAllowed(media[1]))) return signedAnswer(incoming, 404, { error: "No such media." });
		const file = media[2] ? posterFile(MEDIA_DIR, media[1]) : join(MEDIA_DIR, media[1]);
		if (!existsSync(file) || statSync(file).size > MAX_MEDIA) return signedAnswer(incoming, 404, { error: "No such media." });
		const [m] = await sql`select mime from media where id = ${media[1]}::bigint`;
		return signedRawAnswer(incoming, 200, new Uint8Array(await Bun.file(file).arrayBuffer()), media[2] ? "image/jpeg" : m.mime);
	}
	if (method === "POST" && path === "/federation/v1/poke") {
		pokeSoon(incoming.from);
		return signedAnswer(incoming, 202, {});
	}
	return signedAnswer(incoming, 404, { error: "Unknown federation route." });
}

async function mapped(instance: string, kind: "user" | "post" | "media", remoteId: string): Promise<string | undefined> {
	const [row] = await sql`select local_id::text from federated_objects where instance = ${instance} and kind = ${kind} and remote_id = ${remoteId}::bigint`;
	return row?.local_id;
}

async function fetchObject(instance: string, kind: "user" | "post", id: string): Promise<any> {
	if (!isPeer(instance)) return undefined;
	const r = await signedFetch(instance, "GET", `/federation/v1/objects/${kind}/${id}`);
	return r.status === 200 ? r.json() : undefined;
}

export async function resolveUser(value: unknown, depth = 0): Promise<string | undefined> {
	const r = parseRef(value);
	if (!r) return undefined;
	if (r.instance === INSTANCE_ID) {
		const [u] = await sql`select id::text from users where id = ${r.id}::bigint and instance is null`;
		return u?.id;
	}
	if (isBlocked(r.instance)) return undefined;
	const known = await mapped(r.instance, "user", r.id);
	if (known || depth > 2) return known;
	const obj = await fetchObject(r.instance, "user", r.id).catch(() => undefined);
	return obj ? applyUser(r.instance, obj) : undefined;
}

async function resolvePost(value: unknown, depth = 0): Promise<string | undefined> {
	const r = parseRef(value);
	if (!r) return undefined;
	if (r.instance === INSTANCE_ID) {
		const [p] = await publicPost(r.id);
		return p?.id;
	}
	if (isBlocked(r.instance)) return undefined;
	const known = await mapped(r.instance, "post", r.id);
	if (known || depth > 2) return known;
	const obj = await fetchObject(r.instance, "post", r.id).catch(() => undefined);
	return obj ? applyPost(r.instance, obj, depth + 1) : undefined;
}

async function remoteMedia(instance: string, owner: string, m: any, post: string | null, position: number | null): Promise<string | undefined> {
	if (!m || typeof m.id !== "string" || !/^\d{1,19}$/.test(m.id)) return undefined;
	const kind = ["photo", "video", "animated_gif"].includes(m.kind) ? m.kind : "photo";
	const mime = typeof m.mime === "string" && /^(image|video)\/[\w.+-]{1,40}$/.test(m.mime) ? m.mime : "application/octet-stream";
	const width = Number.isInteger(m.width) ? Math.min(Math.max(m.width, 1), 20_000) : 1;
	const height = Number.isInteger(m.height) ? Math.min(Math.max(m.height, 1), 20_000) : 1;
	const alt = typeof m.alt_text === "string" ? m.alt_text.slice(0, 1000) : null;
	const duration = Number.isInteger(m.duration_ms) ? m.duration_ms : null;
	const known = await mapped(instance, "media", m.id);
	if (known) {
		await sql`update media set post_id = ${post}::bigint, position = ${position}, alt_text = ${alt} where id = ${known}::bigint`;
		return known;
	}
	const id = newId();
	await sql`insert into media (id, user_id, kind, mime, size, width, height, post_id, position, alt_text, duration_ms, remote_instance, remote_id)
		values (${id}::bigint, ${owner}::bigint, ${kind}, ${mime}, 0, ${width}, ${height}, ${post}::bigint, ${position}, ${alt}, ${duration}, ${instance}, ${m.id}::bigint)`;
	await sql`insert into federated_objects (instance, kind, remote_id, local_id) values (${instance}, 'media', ${m.id}::bigint, ${id}::bigint) on conflict do nothing`;
	prefetch(id, kind === "video");
	return id;
}

export async function applyUser(instance: string, u: any): Promise<string | undefined> {
	if (typeof u?.id !== "string" || !/^\d{1,19}$/.test(u.id)) return undefined;
	const local = await mapped(instance, "user", u.id);
	if (u.gone) {
		if (local) await sql`delete from users where id = ${local}::bigint and instance = ${instance}`;
		return undefined;
	}
	if (typeof u.screen_name !== "string" || !/^\w{1,50}$/.test(u.screen_name)) return undefined;
	const handle = `${u.screen_name}@${instance}`;
	await sql`update users set screen_name = screen_name || '~' || remote_id::text where lower(screen_name) = lower(${handle}) and instance = ${instance} and remote_id <> ${u.id}::bigint`;
	const created = typeof u.created_at === "string" && !Number.isNaN(Date.parse(u.created_at)) ? new Date(u.created_at) : new Date();
	const id = local ?? newId();
	if (local)
		await sql`update users set screen_name = ${handle}, name = ${clip(u.name, 50)}, bio = ${clip(u.bio, 300)}, location = ${clip(u.location, 60)}, protected = ${!!u.protected}
			where id = ${local}::bigint`;
	else {
		const [{ n }] = await sql`select count(*)::int as n from users where instance = ${instance}`;
		if (n >= MAX_ACCOUNTS) throw new FederationError(`${instance} already has ${MAX_ACCOUNTS} accounts here`);
		await sql`insert into users (id, screen_name, name, password_hash, bio, location, protected, instance, remote_id, created_at)
			values (${id}::bigint, ${handle}, ${clip(u.name, 50)}, '!', ${clip(u.bio, 300)}, ${clip(u.location, 60)}, ${!!u.protected}, ${instance}, ${u.id}::bigint, ${created})
			on conflict (instance, remote_id) where instance is not null do nothing`;
		const again = await mapped(instance, "user", u.id);
		if (again) return again;
		await sql`insert into federated_objects (instance, kind, remote_id, local_id) values (${instance}, 'user', ${u.id}::bigint, ${id}::bigint) on conflict do nothing`;
	}
	const avatar = await remoteMedia(instance, id, u.avatar, null, null);
	const banner = await remoteMedia(instance, id, u.banner, null, null);
	await sql`update users set avatar_url = ${avatar ? `/media/${avatar}` : null}, banner_url = ${banner ? `/media/banner/${banner}` : null} where id = ${id}::bigint`;
	if (u.protected) await sql`delete from posts where user_id = ${id}::bigint`;
	return id;
}

async function applyPost(instance: string, p: any, depth = 0): Promise<string | undefined> {
	if (typeof p?.id !== "string" || !/^\d{1,19}$/.test(p.id)) return undefined;
	const local = await mapped(instance, "post", p.id);
	if (p.gone) {
		if (local) await sql`delete from posts where id = ${local}::bigint`;
		await sql`delete from federated_objects where instance = ${instance} and kind = 'post' and remote_id = ${p.id}::bigint`;
		return undefined;
	}
	const author = await resolveUser(ref(String(p.author ?? ""), instance), depth);
	if (!author) return undefined;
	const text = clip(p.text, 25_000);
	const editedAt = typeof p.edited_at === "string" && !Number.isNaN(Date.parse(p.edited_at)) ? new Date(p.edited_at) : null;
	if (local) {
		await sql`update posts set text = ${text}, sensitive = ${!!p.sensitive}, edited_at = ${editedAt} where id = ${local}::bigint`;
		await attachMedia(instance, author, local, p.media);
		return local;
	}
	const replyTo = p.reply_to ? await resolvePost(p.reply_to, depth) : undefined;
	const quote = p.quote ? await resolvePost(p.quote, depth) : undefined;
	const [parent] = replyTo ? await sql`select conversation_id::text, user_id::text from posts where id = ${replyTo}::bigint` : [];
	if (parent && (await blockedBetween(author, parent.user_id))) return undefined;
	const id = newId();
	const created = typeof p.created_at === "string" && !Number.isNaN(Date.parse(p.created_at)) ? new Date(Math.min(Date.parse(p.created_at), Date.now())) : new Date();
	await sql`insert into posts (id, user_id, text, reply_to_id, reply_to_user_id, conversation_id, quote_id, source, sensitive, edited_at, created_at)
		values (${id}::bigint, ${author}::bigint, ${text}, ${replyTo ?? null}::bigint, ${parent?.user_id ?? null}::bigint, ${parent?.conversation_id ?? id}::bigint,
			${quote ?? null}::bigint, ${instance}, ${!!p.sensitive}, ${editedAt}, ${created})`;
	await sql`insert into federated_objects (instance, kind, remote_id, local_id) values (${instance}, 'post', ${p.id}::bigint, ${id}::bigint) on conflict do nothing`;
	const mentioned = [...text.matchAll(/@(\w{1,15})@([a-z0-9.:-]+)/gi)].filter((m) => m[2].toLowerCase() === INSTANCE_ID).map((m) => m[1].toLowerCase()).slice(0, 20);
	if (mentioned.length)
		await sql`insert into post_mentions (post_id, user_id) select ${id}::bigint, id from users where lower(screen_name) = any(${sql.array(mentioned, "TEXT")}) and instance is null on conflict do nothing`.catch(() => {});
	await attachMedia(instance, author, id, p.media);
	return id;
}

async function attachMedia(instance: string, author: string, post: string, list: unknown) {
	const items = Array.isArray(list) ? list.slice(0, 4) : [];
	const kept: string[] = [];
	for (const [i, m] of items.entries()) {
		const id = await remoteMedia(instance, author, m, post, i);
		if (id) kept.push(id);
	}
	await sql`delete from media where post_id = ${post}::bigint and remote_instance = ${instance} and not (id = any(${sql.array(kept, "INT8")}))`;
}

const blockedBetween = async (a: string, b: string) =>
	(await sql`select 1 from blocks where (blocker_id = ${a}::bigint and blocked_id = ${b}::bigint) or (blocker_id = ${b}::bigint and blocked_id = ${a}::bigint)`).length > 0;

async function applyPair(instance: string, e: any) {
	const actor = await resolveUser(ref(String(e.actor ?? ""), instance));
	if (!actor) return;
	if (e.kind === "follow") {
		const target = await resolveUser(e.target);
		if (!target || target === actor) return;
		if (!e.on) return void (await sql`delete from follows where follower_id = ${actor}::bigint and followee_id = ${target}::bigint`);
		const [t] = await sql`select protected from users where id = ${target}::bigint`;
		if (t?.protected || (await blockedBetween(actor, target))) return;
		await sql`insert into follows (follower_id, followee_id) values (${actor}::bigint, ${target}::bigint) on conflict do nothing`;
		return;
	}
	const post = await resolvePost(e.target);
	if (!post) return;
	const table = e.kind === "like" ? sql`likes` : sql`reposts`;
	if (!e.on) return void (await sql`delete from ${table} where user_id = ${actor}::bigint and post_id = ${post}::bigint`);
	const [owner] = await sql`select user_id::text from posts where id = ${post}::bigint`;
	if (owner && (await blockedBetween(actor, owner.user_id))) return;
	if (e.kind === "like") await sql`insert into likes (user_id, post_id) values (${actor}::bigint, ${post}::bigint) on conflict do nothing`;
	else await sql`insert into reposts (id, user_id, post_id) values (${newId()}::bigint, ${actor}::bigint, ${post}::bigint) on conflict do nothing`;
}

async function applyEvent(instance: string, e: any) {
	if (e?.kind === "user") return void (await applyUser(instance, e));
	if (e?.kind === "post") return void (await applyPost(instance, e));
	if (e?.kind === "like" || e?.kind === "repost" || e?.kind === "follow") return applyPair(instance, e);
}

const pulling = new Set<string>();
const wanted = new Set<string>();

export async function pullFrom(instance: string): Promise<number> {
	if (pulling.has(instance)) {
		wanted.add(instance);
		return 0;
	}
	pulling.add(instance);
	let applied = 0;
	try {
		await sql`insert into federation_peers (instance) values (${instance}) on conflict do nothing`;
		for (let page = 0; page < 20; page++) {
			const [peer] = await sql`select cursor::text from federation_peers where instance = ${instance}`;
			const r = await signedFetch(instance, "GET", `/federation/v1/events?after=${peer.cursor}&limit=${PAGE}`);
			if (r.status !== 200) throw new FederationError(`${instance} answered ${r.status}`);
			const doc = r.json();
			if (!Array.isArray(doc?.events) || !/^\d{1,19}$/.test(String(doc.next))) throw new FederationError(`${instance} sent a malformed page`);
			const previous = budgets.get(instance);
			const budget = previous && Date.now() - previous.start <= 3_600_000 ? previous : { start: Date.now(), used: 0 };
			budgets.set(instance, budget);
			let stoppedAt: string | undefined;
			for (const e of doc.events) {
				if (isBlocked(instance)) return applied;
				if (budget.used >= EVENTS_PER_HOUR) {
					stoppedAt = /^\d{1,19}$/.test(String(e?.seq)) && BigInt(e.seq) > BigInt(peer.cursor) && BigInt(e.seq) <= BigInt(doc.next) ? String(BigInt(e.seq) - 1n) : peer.cursor;
					break;
				}
				budget.used++;
				await applyEvent(instance, e).catch((err) => console.error(`federation: ${instance} event ${e?.seq}:`, err instanceof Error ? err.message : err));
				applied++;
			}
			if (stoppedAt !== undefined) {
				await sql`update federation_peers set cursor = greatest(cursor, ${stoppedAt}::bigint), last_error = ${`paused: more than ${EVENTS_PER_HOUR} changes in an hour`}, last_error_at = now() where instance = ${instance}`;
				return applied;
			}
			await sql`update federation_peers set cursor = greatest(cursor, ${doc.next}::bigint), last_ok_at = now(), last_error = null where instance = ${instance}`;
			if (!doc.more) break;
		}
	} catch (e) {
		await sql`update federation_peers set last_error = ${e instanceof Error ? e.message.slice(0, 500) : String(e)}, last_error_at = now() where instance = ${instance}`;
	} finally {
		pulling.delete(instance);
		if (wanted.delete(instance)) void pullFrom(instance);
	}
	return applied;
}

const pokes = new Map<string, ReturnType<typeof setTimeout>>();
function pokeSoon(instance: string) {
	if (pokes.has(instance) || !isPeer(instance)) return;
	pokes.set(
		instance,
		setTimeout(() => {
			pokes.delete(instance);
			void pullFrom(instance);
		}, 500),
	);
}

let lastPoked = "0";
async function pokePeers() {
	const [{ max }] = await sql`select coalesce(max(seq), 0)::text as max from federation_outbox`;
	if (max === lastPoked) return;
	lastPoked = max;
	await Promise.all(peers().map((p) => signedFetch(p.id, "POST", "/federation/v1/poke", {}).catch(() => undefined)));
}

const fetching = new Map<string, Promise<boolean>>();
export function fetchRemoteMedia(localId: string, poster = false): Promise<boolean> {
	const key = `${localId}${poster ? "p" : ""}`;
	const running = fetching.get(key);
	if (running) return running;
	const job = downloadRemoteMedia(localId, poster).finally(() => fetching.delete(key));
	fetching.set(key, job);
	return job;
}

// Files are fetched when their post or profile syncs, not when someone first
// views them: fetched on view, everything not yet seen went blank while the
// other instance was down. A failing instance is left alone for a while and
// the backfill below picks its files up again.
const QUEUE_PARALLEL = 3;
const BACKOFF_MS = 5 * 60_000;
const queue: { id: string; poster: boolean }[] = [];
const queued = new Set<string>();
const failingUntil = new Map<string, number>();
// answered 404 by their instance: not asked again until the next start
const gone = new Set<string>();
let draining = 0;

function prefetch(localId: string, poster = false) {
	for (const p of poster ? [false, true] : [false]) {
		const key = `${localId}${p ? "p" : ""}`;
		if (queued.has(key) || queue.length >= 10_000) continue;
		queued.add(key);
		queue.push({ id: localId, poster: p });
	}
	drain();
}

function drain() {
	while (draining < QUEUE_PARALLEL && queue.length) {
		const job = queue.shift()!;
		draining++;
		void fetchRemoteMedia(job.id, job.poster)
			.catch(() => false)
			.finally(() => {
				queued.delete(`${job.id}${job.poster ? "p" : ""}`);
				draining--;
				drain();
			});
	}
}

// files still missing (an instance that was down, a server restart mid-queue)
async function backfillMedia() {
	const rows = await sql`select id::text, kind from media where remote_instance is not null and size = 0
		and remote_instance <> all(${sql.array([...failingUntil].filter(([, until]) => until > Date.now()).map(([i]) => i), "TEXT")})
		and id <> all(${sql.array([...gone], "INT8")})
		order by id desc limit 200`;
	for (const r of rows as any[]) prefetch(r.id, r.kind === "video");
}

async function downloadRemoteMedia(localId: string, poster: boolean): Promise<boolean> {
	const [m] = await sql`select remote_instance, remote_id::text from media where id = ${localId}::bigint and remote_instance is not null`;
	if (!m || !isPeer(m.remote_instance)) return false;
	if ((failingUntil.get(m.remote_instance) ?? 0) > Date.now()) return false;
	let failure = "";
	const r = await signedFetch(m.remote_instance, "GET", `/federation/v1/media/${m.remote_id}${poster ? "/poster" : ""}`, undefined, MAX_MEDIA).catch((e) => {
		failure = e instanceof Error ? e.message : String(e);
		return undefined;
	});
	// a 404 is that one file; anything else is the instance
	if (r?.status !== 200) {
		if (r?.status === 404 && !poster) gone.add(localId);
		if (r?.status !== 404) {
			if (!((failingUntil.get(m.remote_instance) ?? 0) > Date.now()))
				console.error(`federation: media from ${m.remote_instance} failing (${failure || `status ${r?.status}`}), retrying in ${BACKOFF_MS / 60_000} minutes`);
			failingUntil.set(m.remote_instance, Date.now() + BACKOFF_MS);
		}
		return false;
	}
	failingUntil.delete(m.remote_instance);
	const file = poster ? posterFile(MEDIA_DIR, localId) : join(MEDIA_DIR, localId);
	mkdirSync(MEDIA_DIR, { recursive: true });
	const temp = `${file}.part${newId()}`;
	writeFileSync(temp, r.body);
	renameSync(temp, file);
	if (!poster) await sql`update media set size = ${r.body.length} where id = ${localId}::bigint`;
	return true;
}

export async function lookupRemoteUser(handle: string): Promise<string | undefined> {
	const m = /^(\w{1,50})@([a-z0-9.:-]{1,260})$/i.exec(handle);
	if (!m) return undefined;
	const instance = m[2].toLowerCase();
	const [known] = await sql`select id::text from users where lower(screen_name) = lower(${`${m[1]}@${instance}`}) and instance = ${instance}`;
	if (known) return known.id;
	if (!isPeer(instance)) return undefined;
	const r = await signedFetch(instance, "GET", `/federation/v1/users/by-name/${m[1]}`).catch(() => undefined);
	return r?.status === 200 ? applyUser(instance, r.json()) : undefined;
}

let started = false;
export function startFederationSync() {
	if (started) return;
	started = true;
	let tick = 0;
	setInterval(() => {
		tick++;
		void pokePeers().catch(() => {});
		if (tick % 5 === 0) for (const p of peers()) void pullFrom(p.id);
		if (tick % 200 === 10) void backfillMedia().catch((e) => console.error("federation: media backfill:", e instanceof Error ? e.message : e));
		if (tick % 3600 === 0) void sql`delete from federation_outbox where created_at < now() - interval '60 days'`.catch(() => {});
	}, 3000).unref();
}
