// Checks the selected GIF provider and media proxy against a running server started
// with KLIPY_API_KEY=test KLIPY_API_URL=http://localhost:39999/v2,
// TENOR_API_KEY=test TENOR_API_URL=http://localhost:39999/v1, and
// GIPHY_API_KEY=test GIPHY_API_URL=http://localhost:39999/giphy. Set GIF_PROVIDER
// to klipy, tenor, or giphy to exercise each provider; default selection is klipy.
// usage: bun scripts/test-gifs.ts <user> <password>

export { };

const origin = `http://localhost:${process.env.PORT ?? 3000}`;
const [name, password] = process.argv.slice(2);
if (!name || !password) throw new Error("usage: bun scripts/test-gifs.ts <user> <password>");

const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0, 0, 0, 0x3b]);
const seen: string[] = [];
const availableProviders = [
	...(process.env.KLIPY_API_KEY ? ["klipy"] : []),
	...(process.env.TENOR_API_KEY === "" ? [] : ["tenor"]),
	...(process.env.GIPHY_API_KEY === "" ? [] : ["giphy"]),
];
const requestedProvider = process.env.GIF_PROVIDER?.toLowerCase();
const provider = requestedProvider && availableProviders.includes(requestedProvider) ? requestedProvider : availableProviders[0] ?? "";
const klipy = Bun.serve({
	port: 39999,
	fetch(req) {
		const url = new URL(req.url);
		seen.push(url.pathname + "?" + url.searchParams.toString());
		if (url.pathname.endsWith(".gif")) return new Response(gif, { headers: { "content-type": "image/gif" } });
		const base = "http://localhost:39999/media";
		if (url.pathname === "/v2/search" || url.pathname === "/v2/featured") {
			return Response.json({
				next: "klipy-page2",
				results: [
					{
						id: "abc",
						content_description: "a cat",
						media_formats: {
							gif: { url: `${base}/abc.gif`, dims: [320, 240] },
							tinygif: { url: `${base}/abc-tiny.gif`, dims: [160, 120] },
							gifpreview: { url: `${base}/abc.gif` },
						},
					},
					{ id: "broken", media_formats: {} },
				],
			});
		}
		if (url.pathname === "/v1/search" || url.pathname === "/v1/trending") {
			return Response.json({
				next: "tenor-page2",
				results: [{
					id: "abc",
					title: "a cat",
					media: [{
						gif: { url: `${base}/tenor.gif`, preview: `${base}/tenor.gif`, dims: [320, 240] },
						tinygif: { url: `${base}/tenor.gif`, preview: `${base}/tenor.gif`, dims: [160, 120] },
					}],
				}],
			});
		}
		if (url.pathname === "/giphy/search" || url.pathname === "/giphy/trending") {
			return Response.json({
				data: [{
					id: "abc",
					title: "a cat",
					images: {
						original: { url: `${base}/giphy.gif`, width: "320", height: "240" },
						fixed_width: { url: `${base}/giphy.gif`, width: "160", height: "120" },
						fixed_width_still: { url: `${base}/giphy.gif`, width: "160", height: "120" },
					},
				}],
				pagination: { count: 1, total_count: 100, offset: Number(url.searchParams.get("offset") ?? 0) },
			});
		}
		return new Response("not found", { status: 404 });
	},
});

const r = await fetch(`${origin}/login`, { method: "POST", body: new URLSearchParams({ username: name, password }), redirect: "manual" });
const cookies = r.headers.getSetCookie().map((c) => c.split(";")[0]);
const csrf = cookies.find((c) => c.startsWith("ct0="))?.slice(4);
if (!csrf) throw new Error("login failed");
const headers = { cookie: cookies.join("; "), "x-csrf-token": csrf };
const get = async (op: string, variables: object) =>
	(await fetch(`${origin}/i/api/graphql/q/${op}?variables=${encodeURIComponent(JSON.stringify(variables))}`, { headers })).json();

let failures = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : `: ${JSON.stringify(detail)}`}`);
}

const raw = await get("GifSearch", { rawQuery: "cat", count: 10 });
const found = raw.data?.gif_search_slice;
const expected = `${provider}_abc`;
check("search returns only the selected provider's items", found?.items?.length === 1 && found.items[0].id === expected, found?.items?.map((item: any) => item.id));
check("items have the shape the client maps", found?.items?.[0]?.full_image?.still_image_url && found.items[0].thumbnail_images.length === 1 && found.items[0].provider?.id === provider);
const expectedPath = provider === "klipy" ? "/v2/search?" : provider === "tenor" ? "/v1/search?" : "/giphy/search?";
const expectedKey = provider === "giphy" ? "api_key=test" : "key=test";
check("selected provider got the query and key", seen.some((s) => s.startsWith(expectedPath) && s.includes("q=cat") && s.includes(expectedKey)));
const otherProviderPaths = provider === "klipy" ? ["/v1/", "/giphy/"] : provider === "tenor" ? ["/v2/", "/giphy/"] : ["/v1/", "/v2/"];
check("other providers were not queried", !seen.some((s) => otherProviderPaths.some((path) => s.startsWith(path))));
const next = found?.slice_info?.next_cursor;
check("search returns a provider cursor", typeof next === "string" && !!next);
await get("GifSearch", { rawQuery: "cat", count: 10, cursor: next });
check("pagination resumes the selected provider", provider === "giphy" ? seen.some((s) => s.startsWith("/giphy/search?") && s.includes("offset=1")) : seen.some((s) => s.includes(provider === "klipy" ? "pos=klipy-page2" : "pos=tenor-page2")));

const trending = (await get("GifEnumerateCategory", { category: "trending", count: 5 })).data?.gif_enumerate_category_slice;
const trendingPath = provider === "klipy" ? "/v2/featured" : provider === "tenor" ? "/v1/trending" : "/giphy/trending";
check("trending uses only the selected provider", trending?.items?.length === 1 && seen.some((s) => s.startsWith(trendingPath)));

const alternateProvider = availableProviders.find((id) => id !== provider);
if (alternateProvider) {
	const save = (id: string) => fetch(`${origin}/account/gifs`, { method: "POST", headers, body: new URLSearchParams({ csrf: csrf!, provider: id }), redirect: "manual" });
	const saved = await save(alternateProvider);
	check("account can save a different GIF provider", saved.status === 303);
	const settingsPage = await fetch(`${origin}/account/gifs`, { headers });
	check("settings shows the saved provider", (await settingsPage.text()).includes(`<option value="${alternateProvider}" selected>`));
	const selected = (await get("GifSearch", { rawQuery: "cat", count: 10 })).data?.gif_search_slice;
	check("GIF search follows the account's provider", selected?.items?.length === 1 && selected.items[0].provider.id === alternateProvider);
	check("account can return to automatic provider selection", (await save("auto")).status === 303);
}

const proxied = await fetch(`${origin}${found.items[0].full_image.url}`, { headers });
check("a result's image comes through the proxy", proxied.status === 200 && proxied.headers.get("content-type") === "image/gif" && (await proxied.arrayBuffer()).byteLength === gif.length);
const evil = await fetch(`${origin}/i/api/xitter/gif?u=${encodeURIComponent("http://example.com/x.gif")}`, { headers });
check("other hosts are refused", evil.status === 403);
const signedOut = await fetch(`${origin}/i/api/xitter/gif?u=${encodeURIComponent("http://localhost:39999/media/abc.gif")}`);
check("signed-out requests are refused", signedOut.status === 401);

klipy.stop();
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
