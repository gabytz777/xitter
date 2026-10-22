// X's client shows a "player" card by framing its own /i/cards-frame/<post id>
// page, not the card's player_url. This is that page: the post's player in a
// frame of its own, for anyone who can see the post.

import { getPost } from "./posts";

const PLAYER_PAGE = /^\/i\/cards(?:-frame|\/tfw\/v1)\/(\d{1,19})\/?$/;
// players the page may frame (links.ts makes these for YouTube)
const PLAYER_ORIGINS = ["https://www.youtube-nocookie.com"];

const esc = (t: string) => t.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export const isPlayerPage = (path: string) => PLAYER_PAGE.test(path);

export async function playerPage(path: string, viewerId: string): Promise<Response> {
	const id = PLAYER_PAGE.exec(path)?.[1];
	const post = id ? await getPost(viewerId, id) : undefined;
	const legacy = (post?.linkCard as any)?.legacy;
	const player = legacy?.name === "player" ? legacy.binding_values.find((b: any) => b.key === "player_url")?.value?.string_value : undefined;
	if (typeof player !== "string" || !PLAYER_ORIGINS.includes(new URL(player).origin)) return new Response("not found", { status: 404 });
	const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;height:100%;background:#000;overflow:hidden}iframe{border:0;width:100%;height:100%;display:block}</style></head>
<body><iframe src="${esc(player)}" allow="autoplay; encrypted-media; fullscreen; picture-in-picture" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe></body></html>`;
	return new Response(html, {
		headers: {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "private, no-store",
			"x-frame-options": "SAMEORIGIN",
			"content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; frame-src ${PLAYER_ORIGINS.join(" ")}; frame-ancestors 'self'`,
		},
	});
}
