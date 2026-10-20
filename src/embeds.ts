// Previews of this instance's links in other apps (Discord, Slack, iMessage,
// Telegram, Mastodon…). Their link fetchers are signed out, so a signed-out
// request for a post or a profile gets a small page with its OpenGraph and
// Twitter card tags and an oEmbed link; people who open it go on to the
// sign-in page as before. Only what a public X account shows anyone is used:
// active, unprotected accounts and their visible posts, with no picture from a
// post marked sensitive. Admin > Settings > Features turns previews off.

import { existsSync } from "node:fs";
import { PUBLIC_ORIGIN } from "./config";
import { sql } from "./db";
import { remoteMediaFile } from "./federation-sync";
import { MEDIA_DIR } from "./media";
import { isId } from "./ids";
import { feature, settings } from "./settings";
import { posterFile } from "./video";

const esc = (t: string) => t.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const clip = (s: string, n: number) => ([...s].length > n ? `${[...s].slice(0, n - 1).join("")}…` : s);

type Author = { id: string; screen_name: string; name: string; bio: string; avatar_url: string | null };

// an account anyone may see: not protected, suspended, limited or deactivated
async function publicAuthor(where: ReturnType<typeof sql>): Promise<Author | undefined> {
	const [u] = await sql`select id::text, screen_name, name, bio, avatar_url from users
		where ${where} and not protected and not instance_blocked and status in ('active', 'restricted') and deactivated_at is null`;
	return u as Author | undefined;
}

type Post = { id: string; text: string; created_at: Date; author: Author; image?: { id: string; kind: string; mime: string; width: number; height: number; remote: boolean } };

async function publicPost(id: string): Promise<Post | undefined> {
	if (!isId(id)) return undefined;
	const [p] = await sql`select p.id::text, p.user_id::text, p.text, p.created_at, p.sensitive and not u.never_sensitive as sensitive, u.never_sensitive from posts p join users u on u.id = p.user_id where p.id = ${id}::bigint and not p.hidden`;
	if (!p) return undefined;
	const author = await publicAuthor(sql`id = ${p.user_id}::bigint`);
	if (!author) return undefined;
	const [m] = p.sensitive
		? []
		: await sql`select id::text, kind, mime, width, height, remote_instance is not null as remote from media
			where post_id = ${id}::bigint and state = 'ready' and (coalesce(cardinality(sensitive_warning), 0) = 0 or ${p.never_sensitive}) order by position nulls last limit 1`;
	return { id: p.id, text: p.text, created_at: p.created_at, author, image: m as Post["image"] };
}

const avatarId = (a: Author) => /^\/media\/(\d{1,19})$/.exec(a.avatar_url ?? "")?.[1];

function page(o: { path: string; title: string; description: string; image?: { url: string; width?: number; height?: number }; large: boolean; author?: Author; time?: Date }): Response {
	const name = settings().instance_name;
	const url = PUBLIC_ORIGIN + o.path;
	const image = o.image ?? { url: `${PUBLIC_ORIGIN}/public/icon-dark.png` };
	const tags: [string, string, string][] = [
		["property", "og:site_name", name],
		["property", "og:type", o.time ? "article" : "profile"],
		["property", "og:url", url],
		["property", "og:title", o.title],
		["property", "og:description", o.description],
		["property", "og:image", image.url],
		...(image.width && image.height ? ([["property", "og:image:width", String(image.width)], ["property", "og:image:height", String(image.height)]] as [string, string, string][]) : []),
		...(o.time ? ([["property", "article:published_time", o.time.toISOString()]] as [string, string, string][]) : []),
		["name", "twitter:card", o.large ? "summary_large_image" : "summary"],
		["name", "twitter:title", o.title],
		["name", "twitter:description", o.description],
		["name", "twitter:image", image.url],
		["name", "description", o.description],
		["name", "theme-color", "#1d9bf0"],
	];
	const oembed = `${PUBLIC_ORIGIN}/oembed?url=${encodeURIComponent(url)}`;
	const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<title>${esc(o.title)}</title>
${tags.map(([attr, key, value]) => `<meta ${attr}="${key}" content="${esc(value)}">`).join("\n")}
<link rel="canonical" href="${esc(url)}">
<link rel="alternate" type="application/json+oembed" href="${esc(oembed)}" title="${esc(o.title)}">
<meta http-equiv="refresh" content="0;url=/">
</head><body style="background:#000;color:#e7e9ea;font-family:sans-serif"><p><a href="/" style="color:#1d9bf0">Sign in to ${esc(name)}</a> to see this.</p></body></html>`;
	return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

const postTitle = (a: Author) => `${a.name} (@${a.screen_name})`;

function postPreview(p: Post): Response {
	const photo = p.image && (p.image.kind === "photo" || p.image.remote || existsSync(posterFile(MEDIA_DIR, p.image.id)));
	const avatar = avatarId(p.author);
	return page({
		path: `/${p.author.screen_name}/status/${p.id}`,
		title: `${postTitle(p.author)} on ${settings().instance_name}`,
		description: clip(p.text, 300) || "Post",
		image: photo
			? { url: `${PUBLIC_ORIGIN}/embed/post/${p.id}`, width: p.image!.width, height: p.image!.height }
			: avatar
				? { url: `${PUBLIC_ORIGIN}/embed/avatar/${p.author.id}` }
				: undefined,
		large: !!photo,
		author: p.author,
		time: p.created_at,
	});
}

function profilePreview(a: Author): Response {
	return page({
		path: `/${a.screen_name}`,
		title: `${postTitle(a)} on ${settings().instance_name}`,
		description: clip(a.bio, 300) || `@${a.screen_name}`,
		image: avatarId(a) ? { url: `${PUBLIC_ORIGIN}/embed/avatar/${a.id}` } : undefined,
		large: false,
		author: a,
	});
}

const handleIn = (pathname: string) => {
	const raw = /^\/([^/]{1,320})\/?$/.exec(pathname)?.[1];
	try {
		const name = raw && decodeURIComponent(raw);
		return name && /^[^\s\p{C}/\\?#@%,:]{1,50}(?:@[a-z0-9.:-]{1,260})?$/iu.test(name) ? name : undefined;
	} catch {
		return undefined;
	}
};

// a signed-out page request: the preview page, or undefined to carry on as before
export async function linkPreview(pathname: string): Promise<Response | undefined> {
	if (!feature("link_previews")) return undefined;
	const status = /^\/([^/]{1,320})\/status\/(\d{1,19})(?:\/(?:photo|video)\/\d)?\/?$/i.exec(pathname);
	if (status) {
		const post = await publicPost(status[2]);
		return post ? postPreview(post) : undefined;
	}
	const profile = handleIn(pathname);
	if (profile) {
		const author = await publicAuthor(sql`lower(screen_name) = lower(${profile})`);
		return author ? profilePreview(author) : undefined;
	}
	return undefined;
}

async function fileResponse(body: Blob | undefined, type: string): Promise<Response> {
	if (!body) return new Response("not found", { status: 404, headers: { "cache-control": "no-store" } });
	return new Response(body, { headers: { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}

// the pictures the preview pages name: a public post's first photo or video
// frame, a public account's avatar. Other uploads stay for signed-in users.
export async function embedImage(pathname: string): Promise<Response> {
	const none = new Response("not found", { status: 404, headers: { "cache-control": "no-store" } });
	if (!feature("link_previews")) return none;
	const post = /^\/embed\/post\/(\d{1,19})$/.exec(pathname);
	if (post) {
		const p = await publicPost(post[1]);
		if (!p?.image) return none;
		return p.image.kind === "photo" ? fileResponse(await remoteMediaFile(p.image.id), p.image.mime) : fileResponse(await remoteMediaFile(p.image.id, true), "image/jpeg");
	}
	const avatar = /^\/embed\/avatar\/(\d{1,19})$/.exec(pathname);
	if (avatar && isId(avatar[1])) {
		const a = await publicAuthor(sql`id = ${avatar[1]}::bigint`);
		const id = a && avatarId(a);
		if (!id || !isId(id)) return none;
		const [m] = await sql`select mime from media where id = ${id}::bigint`;
		return m ? fileResponse(await remoteMediaFile(id), m.mime) : none;
	}
	return none;
}

// oEmbed (oembed.com): apps such as Discord show the author line from it
export async function oembed(url: URL): Promise<Response> {
	const none = new Response("not found", { status: 404, headers: { "cache-control": "no-store" } });
	if (!feature("link_previews")) return none;
	let target: URL;
	try {
		target = new URL(url.searchParams.get("url") ?? "");
	} catch {
		return none;
	}
	if (target.origin !== PUBLIC_ORIGIN) return none;
	const status = /^\/[^/]{1,320}\/status\/(\d{1,19})/i.exec(target.pathname);
	const author = status
		? (await publicPost(status[1]))?.author
		: await publicAuthor(sql`lower(screen_name) = lower(${handleIn(target.pathname) ?? ""})`);
	if (!author) return none;
	return Response.json(
		{
			version: "1.0",
			type: "link",
			title: postTitle(author),
			author_name: postTitle(author),
			author_url: `${PUBLIC_ORIGIN}/${author.screen_name}`,
			provider_name: settings().instance_name,
			provider_url: PUBLIC_ORIGIN,
		},
		{ headers: { "cache-control": "no-store", "access-control-allow-origin": "*" } },
	);
}
