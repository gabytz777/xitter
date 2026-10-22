import { expect, test } from "bun:test";
import { linkCard, linksIn, parsePreview, previewable, proxied, urlEntities, youtubeOf } from "../src/links";

test("finds links and trims punctuation", () => {
	expect(linksIn("see https://example.com/a. and (https://en.wikipedia.org/wiki/Foo_(bar)) ok").map((l) => l.url)).toEqual(["https://example.com/a", "https://en.wikipedia.org/wiki/Foo_(bar)"]);
	expect(linksIn("no links here")).toEqual([]);
});

test("entities count code points and shorten the display", () => {
	const [e] = urlEntities("🏳️‍⚧️ https://www.example.com/a/very/long/path/that/goes/on");
	expect(e.indices[0]).toBe([..."🏳️‍⚧️ "].length);
	expect(e.display_url).toBe("example.com/a/very/long/p…");
	expect(e.expanded_url).toBe("https://www.example.com/a/very/long/path/that/goes/on");
});

test("private and local hosts aren't previewed", () => {
	for (const u of ["http://localhost:3000/x", "http://127.0.0.1/", "http://10.0.0.5/", "http://192.168.1.1/", "http://[::1]/", "http://user:pw@example.com/", "ftp://example.com/"]) expect(previewable(u)).toBe(false);
	expect(previewable("https://example.com/")).toBe(true);
});

test("parses OpenGraph tags and proxies the image", () => {
	const html = `<html><head><title>Fallback</title><meta property="og:title" content="Bun &amp; friends"><meta content="A runtime" property="og:description">
		<meta property="og:image" content="/img.png"><meta property="og:image:width" content="1200"><meta property="og:site_name" content="GitHub"></head></html>`;
	const p = parsePreview("https://github.com/oven-sh/bun", html);
	expect(p?.title).toBe("Bun & friends");
	expect(p?.description).toBe("A runtime");
	expect(p?.image).toBe("https://github.com/img.png");
	const card: any = linkCard(p!);
	expect(card.legacy.name).toBe("summary_large_image");
	const image = card.legacy.binding_values.find((b: any) => b.key === "thumbnail_image_large").value.image_value.url;
	expect(image).toBe(proxied("https://github.com/img.png"));
	expect(image.startsWith("https://cors.estrogen.delivery/?url=")).toBe(true);
});

test("a page without a title gives no card", () => {
	expect(parsePreview("https://example.com", "<html><body>hi</body></html>")).toBeUndefined();
	expect(parsePreview("https://example.com", "<title>Just a title</title>")?.image).toBeNull();
});

test("recognises YouTube video links", () => {
	for (const u of ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "https://youtu.be/dQw4w9WgXcQ", "https://m.youtube.com/watch?v=dQw4w9WgXcQ&list=x", "https://youtube.com/shorts/dQw4w9WgXcQ", "https://www.youtube.com/live/dQw4w9WgXcQ?si=a", "https://music.youtube.com/watch?v=dQw4w9WgXcQ"])
		expect(youtubeOf(u)).toEqual({ id: "dQw4w9WgXcQ", start: 0 });
	expect(youtubeOf("https://youtu.be/dQw4w9WgXcQ?t=90")?.start).toBe(90);
	expect(youtubeOf("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1m5s")?.start).toBe(65);
	for (const u of ["https://www.youtube.com/@channel", "https://www.youtube.com/watch?v=short", "https://notyoutube.com/watch?v=dQw4w9WgXcQ", "https://www.youtube.com/playlist?list=PL1"]) expect(youtubeOf(u)).toBeUndefined();
});

test("YouTube links become player cards", () => {
	const card: any = linkCard({ url: "https://youtu.be/dQw4w9WgXcQ?t=42", title: "A video", description: "A channel", site: "YouTube", image: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg", width: 480, height: 360 });
	const value = (key: string) => card.legacy.binding_values.find((b: any) => b.key === key)?.value;
	expect(card.legacy.name).toBe("player");
	expect(value("player_url").string_value).toBe("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=42");
	expect(value("player_image").image_value.url).toBe(proxied("https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg"));
	expect(linkCard({ url: "https://example.com/", title: "x", description: "", site: "", image: null, width: 0, height: 0 }).legacy.name).toBe("summary");
});
