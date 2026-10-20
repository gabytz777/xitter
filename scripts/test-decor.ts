// Profile decor from Steam: only gold-check accounts wear it, picks are checked
// against Steam, and the files come through /public/steam/.
// usage: bun scripts/test-decor.ts <gold account> <other account> <password> [admin]   (against a running server; needs Steam reachable)
import { sql } from "../src/db";

const origin = `http://localhost:${process.env.PORT ?? 3000}`;
const [goldName, otherName, password, adminName] = process.argv.slice(2);
if (!password) throw new Error("usage: bun scripts/test-decor.ts <gold account> <other account> <password>");

let failed = 0;
const check = (ok: boolean, label: string) => {
	if (!ok) failed++;
	console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
};

async function signIn(name: string) {
	const r = await fetch(`${origin}/login`, { method: "POST", body: new URLSearchParams({ username: name, password }), redirect: "manual" });
	const cookies = r.headers.getSetCookie().map((c) => c.split(";")[0]);
	const csrf = cookies.find((c) => c.startsWith("ct0="))?.slice(4);
	if (!csrf) throw new Error(`login ${name} failed`);
	const cookie = cookies.join("; ");
	const page = await fetch(`${origin}/account/decor`, { headers: { cookie } }).then((r) => r.text());
	const formCsrf = /name="csrf" value="([^"]+)"/.exec(page)?.[1] ?? "";
	return {
		page,
		admin: (action: string, body: object) =>
			fetch(`${origin}/admin/api/${action}`, { method: "POST", headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" }, body: JSON.stringify(body) }),
		api: (path: string) => fetch(`${origin}/i/api${path}`, { headers: { cookie, "x-csrf-token": csrf } }),
		post: (fields: Record<string, string>) =>
			fetch(`${origin}/account/decor`, { method: "POST", headers: { cookie }, body: new URLSearchParams({ csrf: formCsrf, ...fields }), redirect: "manual" }),
	};
}

const [before] = await sql`select decor from users where lower(screen_name) = lower(${goldName})`;
try {
	const gold = await signIn(goldName);
	const other = await signIn(otherName);
	check(gold.page.includes("Steam items"), "a gold-check account gets the picker");
	check(!other.page.includes("Steam items"), "another account doesn't");

	const frames = await gold.api("/xitter/decor/shop?kind=frame").then((r) => r.json());
	check(frames.items?.length > 0, `the shop lists avatar frames (${frames.items?.length})`);
	const portal = await gold.api("/xitter/decor/shop?kind=background&q=portal%202").then((r) => r.json());
	check(portal.items?.length > 0 && portal.items.every((i: any) => i.appid === 620 || i.appid === 400), `searching a game finds its backgrounds (${portal.items?.length})`);
	const animated = await gold.api("/xitter/decor/shop?kind=background").then((r) => r.json());
	const moving = animated.items?.find((i: any) => i.movie);

	check((await other.post({ kind: "frame", defid: String(frames.items[0].defid) })).status === 400, "another account can't wear a frame");
	check((await gold.post({ kind: "frame", defid: String(portal.items[0].defid) })).status === 400, "a background can't go in the frame slot");
	check((await gold.post({ kind: "frame", defid: "abc" })).status === 400, "a made-up item is refused");
	check((await gold.post({ theme: "NotATheme" })).status === 400, "an unknown theme is refused");
	check((await gold.post({ kind: "frame", defid: String(frames.items[0].defid), csrf: "wrong" })).status === 400, "a form without the csrf token is refused");

	check((await gold.post({ kind: "frame", defid: String(frames.items[0].defid) })).status === 303, "a gold-check account wears a frame");
	check((await gold.post({ kind: "background", defid: String((moving ?? portal.items[0]).defid) })).status === 303, "and a background");
	check((await gold.post({ theme: "Cosmic" })).status === 303, "and a theme");

	const worn = await other.api(`/xitter/decor?names=${goldName},${otherName}`).then((r) => r.json());
	const mine = worn[goldName.toLowerCase()];
	check(!!mine?.frame && !!mine?.background?.image && mine?.theme?.id === "Cosmic", "others see all three");
	check(!worn[otherName.toLowerCase()], "an account without decor isn't listed");
	check(!moving || !!mine?.background?.movie, "an animated background comes with its video");

	const file = await fetch(`${origin}${mine.frame}`);
	check(file.ok && file.headers.get("content-type") === "image/png", `the frame comes from /public/steam (${file.status})`);
	if (mine.background.movie) {
		const part = await fetch(`${origin}${mine.background.movie}`, { headers: { range: "bytes=0-99" } });
		check(part.status === 206 && (await part.arrayBuffer()).byteLength === 100, `the video is served in pieces (${part.status})`);
	}
	check((await fetch(`${origin}/public/steam/620/..%2F..%2Fsecret.png`)).status === 404, "only Steam's own file names are served");
	// an item nobody wears isn't fetched for strangers, nor kept
	const unworn = frames.items.find((i: any) => i.defid !== frames.items[0].defid);
	check((await fetch(`${origin}${unworn.thumb}`)).status === 404, "a signed-out visitor can't fetch an item nobody wears");
	check((await gold.api(`/../../public/steam/${unworn.appid}/${unworn.image}`)).ok, "a signed-in account browsing the shop can");
	const video = animated.items?.find((i: any) => i.movie && i.defid !== moving?.defid);
	if (video) {
		check((await fetch(`${origin}/public/steam/${video.appid}/${video.preview}`)).status === 404, "a signed-out visitor can't play a shop preview");
		const clip = await gold.api(`/../../public/steam/${video.appid}/${video.preview}`);
		check(clip.ok && clip.headers.get("content-type") === "video/webm", `a signed-in account plays it (${clip.status})`);
		await clip.body?.cancel();
		check(!(await Bun.file(`media/steam/${video.appid}/${video.preview}`).exists()), "and it isn't kept on the server");
	}

	// animated frames move, and Steam's events are a category of their own
	const still = frames.items.find((i: any) => i.anim);
	check(!!still?.moving && still.moving.endsWith(still.anim), "an animated frame has its moving file");
	const catalog = await gold.api("/xitter/decor/catalog").then((r) => r.json());
	const events = catalog.events;
	check(Array.isArray(events) && events.length > 10 && events.every((e: any) => e.name), `Steam's events are listed with names (${events?.length})`);
	check(catalog.games?.length > 1000 && catalog.games.some((g: any) => g.appid === 620 && g.name === "Portal 2"), `games are listed A to Z (${catalog.games?.length})`);
	const portalFrames = await gold.api("/xitter/decor/shop?kind=background&app=620").then((r) => r.json());
	check(portalFrames.items?.length > 0 && portalFrames.items.every((i: any) => i.appid === 620), "one game shows only its items");
	const onlyMoving = await gold.api("/xitter/decor/shop?kind=background&animated=1").then((r) => r.json());
	check(onlyMoving.items?.length > 0 && onlyMoving.items.every((i: any) => i.movie), `"Animated" shows only what moves (${onlyMoving.items?.length})`);

	// a game profile puts its background and frame on, and says where they came from
	const profiles = await gold.api("/xitter/decor/shop?kind=profile").then((r) => r.json());
	check(profiles.items?.length > 0, `game profiles are listed (${profiles.items?.length})`);
	check((await gold.post({ kind: "profile", defid: "198096" })).status === 303, "a gold-check account wears Dying Light 2's game profile");
	const [dl2] = await sql`select decor from users where lower(screen_name) = lower(${goldName})`;
	check(dl2.decor?.profile?.defid === 198096 && dl2.decor?.background?.appid === 534380 && dl2.decor?.frame?.appid === 534380, "its background and frame are on");
	check((await gold.post({ kind: "profile", defid: String(frames.items[0].defid) })).status === 400, "a frame isn't a game profile");
	const eventIds = new Set(events.map((e: any) => e.appid));
	const fromEvents = await gold.api("/xitter/decor/shop?kind=frame&event=all").then((r) => r.json());
	check(fromEvents.items?.length > 0 && fromEvents.items.every((i: any) => eventIds.has(i.appid)), `"Steam events" shows only event items (${fromEvents.items?.length})`);
	const one = fromEvents.items[0].appid;
	const single = await gold.api(`/xitter/decor/shop?kind=frame&event=${one}`).then((r) => r.json());
	check(single.items?.length > 0 && single.items.every((i: any) => i.appid === one), "one event shows only its own items");
	check((await gold.api("/xitter/decor/shop?kind=frame&event=nope")).status === 400, "a made-up event is refused");

	// a grey check wears it too; a blue one hides it, without forgetting it
	await sql`update users set verified_type = 'government' where lower(screen_name) = lower(${goldName})`;
	const grey = await other.api(`/xitter/decor?names=${goldName}`).then((r) => r.json());
	check(!!grey[goldName.toLowerCase()], "a grey check shows it too");
	check((await gold.post({ theme: "Steel" })).status === 303, "and can change it");
	await sql`update users set verified_type = 'blue' where lower(screen_name) = lower(${goldName})`;
	const hidden = await other.api(`/xitter/decor?names=${goldName}`).then((r) => r.json());
	check(!hidden[goldName.toLowerCase()], "with a blue check nothing shows");
	await sql`update users set verified_type = 'business' where lower(screen_name) = lower(${goldName})`;

	// staff can take it off; an account without the permission can't
	if (adminName) {
		const [g] = await sql`select id::text as id from users where lower(screen_name) = lower(${goldName})`;
		check((await other.admin("resetDecor", { id: g.id })).status === 403, "an account that isn't staff can't reset decor");
		const staff = await signIn(adminName);
		check((await staff.admin("resetDecor", { id: g.id })).ok, "staff reset an account's decor");
		const [reset] = await sql`select decor from users where id = ${g.id}::bigint`;
		check(reset.decor === null, "it's gone");
		const [logged] = await sql`select detail from audit_log where action = 'reset_decor' and target = ${g.id} order by created_at desc limit 1`;
		check(!!logged?.detail?.frame, "the audit log says what it was");
		await gold.post({ theme: "Cosmic" });
	}

	for (const f of [{ kind: "frame", defid: "" }, { kind: "background", defid: "" }, { theme: "" }]) await gold.post(f);
	const [after] = await sql`select decor from users where lower(screen_name) = lower(${goldName})`;
	check(after.decor === null, "removing all three clears it");
} finally {
	await sql`update users set verified_type = 'business', decor = ${before?.decor ? JSON.stringify(before.decor) : null}::text::jsonb where lower(screen_name) = lower(${goldName})`;
}
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
