// Discord sign-in without Discord: the token and /users/@me calls are stubbed,
// so the whole callback runs against the real database — creating an account,
// linking one, signing a linked one in, the reset it stands in for, and the
// reset-link DM. Needs a disposable local database; no server, no network.
// DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/xitter_test \
//   DISCORD_CLIENT_ID=test DISCORD_CLIENT_SECRET=test bun scripts/test-discord-login.ts

import assert from "node:assert";
import { createUser, getViewer, login, type Viewer } from "../src/auth";
import { PUBLIC_ORIGIN } from "../src/config";
import { sql } from "../src/db";
import { resetRoute } from "../src/password-reset";
import { issueResetToken } from "../src/reset-tokens";
import { setSetting } from "../src/settings";
import { requestReset } from "../src/password-reset";

const database = new URL(process.env.DATABASE_URL ?? "postgres://localhost/xitter");
assert(["localhost", "127.0.0.1"].includes(database.hostname) && /test|codex/.test(database.pathname), "Use a disposable local test database.");

process.env.DISCORD_CLIENT_ID ??= "123456789012345678";
process.env.DISCORD_CLIENT_SECRET ??= "test-secret";
delete process.env.RESEND_API_KEY;
delete process.env.SMTP_URL;

const { discordStart, discordCallback, discordAccountRoute, dmUser } = await import("../src/discord");
const { passwordOrStepUp, stepUpActive } = await import("../src/step-up");

const realFetch = globalThis.fetch;
let who: Record<string, unknown> = {};
let discordCalls: { url: string; init?: RequestInit }[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
	const url = String(input);
	discordCalls.push({ url, init });
	if (url.includes("/oauth2/token")) return Response.json({ access_token: "access-token" });
	if (url.endsWith("/users/@me")) return Response.json(who);
	if (url.endsWith("/users/@me/channels")) return Response.json({ id: "dm-1" });
	if (url.endsWith("/channels/dm-1/messages")) return Response.json({ id: "m-1" });
	return new Response("not found", { status: 404 });
}) as typeof fetch;

let failures = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : `: ${JSON.stringify(detail)}`}`);
}

const req = (path: string, cookie = "") => new Request(`${PUBLIC_ORIGIN}${path}`, { headers: cookie ? { cookie } : {} });
const jarOf = (res: Response) =>
	Object.fromEntries(
		res.headers.getSetCookie().map((c) => {
			const pair = c.split(";")[0]!;
			const at = pair.indexOf("=");
			return [pair.slice(0, at), pair.slice(at + 1)];
		}),
	);
const header = (jar: Record<string, string>) =>
	Object.entries(jar)
		.filter(([, v]) => v !== "")
		.map(([k, v]) => `${k}=${v}`)
		.join("; ");

// one trip to Discord and back, with whatever Discord would have said
async function roundTrip(opts: { purpose?: string; next?: string; viewer?: Viewer | null; cookie?: string; discord?: Record<string, unknown> } = {}) {
	who = opts.discord ?? who;
	const params = new URLSearchParams();
	if (opts.purpose) params.set("purpose", opts.purpose);
	if (opts.next) params.set("next", opts.next);
	const path = `/oauth/discord${params.size ? `?${params}` : ""}`;
	const out = discordStart(req(path), new URL(`${PUBLIC_ORIGIN}${path}`));
	const jar = jarOf(out);
	const state = new URL(out.headers.get("location")!).searchParams.get("state")!;
	const cookie = [opts.cookie, header(jar)].filter(Boolean).join("; ");
	const back = await discordCallback(req(`/oauth/discord/callback?code=code-${Math.random()}&state=${state}`, cookie), new URL(`${PUBLIC_ORIGIN}/oauth/discord/callback?code=the-code&state=${state}`), opts.viewer ?? null);
	return { out, jar, back };
}

const stamp = Date.now();
const created: string[] = [];
try {
	// what a new account follows, so the sign-up's own follow can be seen
	const alertsId = await createUser(`al${stamp % 1e7}`, "Alerts", "testpass123");
	created.push(alertsId);
	await setSetting("default_follows", [`al${stamp % 1e7}`]);
	await setSetting("signup_mode", "open");

	// a Discord account nobody here has yet, signing in for the first time
	who = { id: `90000${stamp}`, username: "Some.One", global_name: "Some One", email: `discord-${stamp}@example.test`, verified: true };
	const first = await roundTrip();
	const firstText = first.back.status === 303 ? "" : await first.back.clone().text();
	check("a new Discord account is signed in", first.back.status === 303 && first.back.headers.get("location") === "/home", { status: first.back.status, page: firstText.match(/class="error">([^<]*)/)?.[1] });
	const sessionCookie = first.back.headers.getSetCookie().find((c) => c.startsWith("auth_token="));
	check("with the instance's own session cookie", !!sessionCookie, sessionCookie?.slice(0, 20));
	const viewer = await getViewer(new Request(`${PUBLIC_ORIGIN}/`, { headers: { cookie: first.back.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") } }));
	check("the session is the new account", !!viewer?.id);
	const userId = viewer!.id;
	created.push(userId);
	const [account] = await sql`select screen_name, name, email, signup_source, email_verified from users where id = ${userId}::bigint`;
	check("the handle is their Discord name, made to fit", account?.screen_name === "someone", account?.screen_name);
	check("the name is their Discord display name", account?.name === "Some One", account?.name);
	check("the email came from Discord, verified by it", account?.email === `discord-${stamp}@example.test` && account?.email_verified === true, account?.email);
	check("the sign-up says where it came from", account?.signup_source === "discord", account?.signup_source);
	const [link] = await sql`select discord_id, username from discord_accounts where user_id = ${userId}::bigint`;
	check("the Discord account is linked to it", link?.discord_id === who.id && link.username === "Some.One", link);
	const follows = await sql`select u.screen_name from follows f join users u on u.id = f.followee_id where f.follower_id = ${userId}::bigint order by u.screen_name`;
	check("it follows what a new account follows", follows.length === 1 && follows[0]!.screen_name === `al${stamp % 1e7}`, follows.map((f: any) => f.screen_name));
	const events = await sql`select count(*)::int as n from login_events where user_id = ${userId}::bigint`;
	check("the sign-in is in the access history", events[0]!.n === 1, events[0]!.n);

	// the same Discord account again: signed in, not created twice
	const second = await roundTrip();
	const [same] = await sql`select user_id::text from discord_accounts where discord_id = ${who.id}`;
	check("the same Discord account signs in again", second.back.status === 303 && same?.user_id === userId, { status: second.back.status, user: same?.user_id });
	const [{ n: users }] = await sql`select count(*)::int as n from users where email = ${account!.email}`;
	check("and is not a second account", users === 1, users);

	// an existing account links Discord, then uses it to reset a password
	const name = `d${stamp % 1e8}`;
	const linkedId = await createUser(name, "Linked One", "testpass123");
	created.push(linkedId);
	const login1 = await login(name, "testpass123");
	const cookieOf = (token: string) => `auth_token=${token}`;
	const signedIn = await getViewer(req("/", cookieOf(login1!.token)));
	check("an existing account can be signed in", !!signedIn);
	check("nothing is linked at first", (await (await discordAccountRoute(req("/account/discord", cookieOf(login1!.token)), new URL(`${PUBLIC_ORIGIN}/account/discord`), signedIn!)).text()).includes("No Discord account is linked"));
	const linked = await roundTrip({ viewer: signedIn, discord: { id: `80000${stamp}`, username: "second.one", global_name: "Second One", verified: false } });
	check("linking comes back to the Discord page", linked.back.status === 303 && linked.back.headers.get("location") === "/account/discord", { status: linked.back.status });
	const [link2] = await sql`select user_id::text from discord_accounts where discord_id = ${`80000${stamp}`}`;
	check("the link is theirs", link2?.user_id === linkedId, link2);
	const page = await (await discordAccountRoute(req("/account/discord", cookieOf(login1!.token)), new URL(`${PUBLIC_ORIGIN}/account/discord`), signedIn!)).text();
	check("the page says which Discord account it is", page.includes("Second One") && page.includes("@second.one"), page.slice(page.indexOf("Second One"), page.indexOf("Second One") + 60));

	// reset: Discord proves who they are, no link and no mail needed
	discordCalls = [];
	const reset = await roundTrip({ purpose: "reset", discord: { id: `80000${stamp}`, username: "second.one" } });
	check("a reset trip ends on the reset page", reset.back.status === 303 && reset.back.headers.get("location")!.startsWith("/account/reset?token="), reset.back.headers.get("location"));
	const token = new URL(reset.back.headers.get("location")!, PUBLIC_ORIGIN).searchParams.get("token")!;
	const form = await resetRoute(req(`/account/reset?token=${token}`), new URL(`${PUBLIC_ORIGIN}/account/reset?token=${token}`));
	check("the link is a working one", form.status === 200 && (await form.text()).includes("Choose a new password"));
	const body = new FormData();
	body.set("token", token);
	body.set("password", "newpass12345");
	body.set("confirm", "newpass12345");
	const changed = await resetRoute(new Request(`${PUBLIC_ORIGIN}/account/reset`, { method: "POST", body }), new URL(`${PUBLIC_ORIGIN}/account/reset`));
	check("the password is changed", changed.status === 200 && (await changed.text()).includes("Password changed"));
	check("the new password works", !!(await login(name, "newpass12345")));
	check("the old one doesn't", !(await login(name, "testpass123")));

	// "confirm with Discord": the round trip itself is the proof, and it comes
	// back to the page that asked, letting the password screens through a while
	check("nothing is confirmed yet", !(await stepUpActive(linkedId)));
	const confirm = await roundTrip({ purpose: "stepup", next: "/account/passkeys", viewer: signedIn, discord: { id: `80000${stamp}`, username: "second.one" } });
	check("confirming comes back to where it was asked", confirm.back.status === 303 && confirm.back.headers.get("location") === "/account/passkeys", {
		status: confirm.back.status,
		at: confirm.back.headers.get("location"),
	});
	check("and the account is confirmed", await stepUpActive(linkedId));
	const [linkedNow] = await sql`select password_hash from users where id = ${linkedId}::bigint`;
	check("the password screens now take no password at all", await passwordOrStepUp(linkedId, "", linkedNow.password_hash));
	const stranger = await roundTrip({ purpose: "stepup", viewer: signedIn, discord: { id: `70000${stamp}`, username: "stranger" } });
	check("another Discord account cannot confirm for you", stranger.back.status === 400 && (await stranger.back.text()).includes("different Discord account"));
	const sneaky = await roundTrip({ purpose: "stepup", next: "//evil.example/x", viewer: signedIn, discord: { id: `80000${stamp}`, username: "second.one" } });
	check("a hostile next falls back to the Discord page", sneaky.back.status === 303 && sneaky.back.headers.get("location") === "/account/discord", sneaky.back.headers.get("location"));
	await sql`update step_up_grants set until = now() - interval '1 minute' where user_id = ${linkedId}::bigint`;
	check("an expired confirmation stops working", !(await stepUpActive(linkedId)) && !(await passwordOrStepUp(linkedId, "", linkedNow.password_hash)));
	check("the password itself works", await passwordOrStepUp(linkedId, "newpass12345", linkedNow.password_hash));
	check("a wrong one is still wrong", !(await passwordOrStepUp(linkedId, "not-the-password", linkedNow.password_hash)));

	// changing the password takes the confirmation with it
	await roundTrip({ purpose: "stepup", viewer: signedIn, discord: { id: `80000${stamp}`, username: "second.one" } });
	check("confirmed again for the revocation check", await stepUpActive(linkedId));
	const resetToken = await issueResetToken(linkedId);
	const again = new FormData();
	again.set("token", resetToken);
	again.set("password", "anotherpass123");
	again.set("confirm", "anotherpass123");
	await resetRoute(new Request(`${PUBLIC_ORIGIN}/account/reset`, { method: "POST", body: again }), new URL(`${PUBLIC_ORIGIN}/account/reset`));
	check("changing the password revokes the confirmation", !(await stepUpActive(linkedId)));

	// a Discord account already linked elsewhere is refused, not moved
	check("the link is still there after the reset", (await sql`select 1 from discord_accounts where user_id = ${linkedId}::bigint`).length === 1);
	const otherName = `e${stamp % 1e8}`;
	const otherId = await createUser(otherName, "Other One", "testpass123");
	created.push(otherId);
	const otherLogin = await login(otherName, "testpass123");
	const otherViewer = await getViewer(req("/", cookieOf(otherLogin!.token)));
	const clash = await roundTrip({ viewer: otherViewer, discord: { id: `80000${stamp}`, username: "second.one" } });
	const clashPage = await clash.back.text();
	check("a Discord account can't be on two accounts here", clashPage.includes("already linked to another account"), clashPage.match(/That didn't work[\s\S]{0,200}/)?.[0]);

	// unlinking, with the form's csrf token
	const unlinkBody = new FormData();
	unlinkBody.set("csrf", "wrong");
	const wrongCsrf = await discordAccountRoute(new Request(`${PUBLIC_ORIGIN}/account/discord/unlink`, { method: "POST", body: unlinkBody }), new URL(`${PUBLIC_ORIGIN}/account/discord/unlink`), signedIn!);
	check("unlinking without the form's token is refused", wrongCsrf.status === 403);
	const unlink = new FormData();
	unlink.set("csrf", signedIn!.csrf);
	const unlinked = await discordAccountRoute(new Request(`${PUBLIC_ORIGIN}/account/discord/unlink`, { method: "POST", body: unlink }), new URL(`${PUBLIC_ORIGIN}/account/discord/unlink`), signedIn!);
	check("unlinking removes it", unlinked.status === 303 && (await sql`select 1 from discord_accounts where user_id = ${linkedId}::bigint`).length === 0);

	// a Discord account with no verified email can't become one here
	const nameless = await roundTrip({ purpose: "", discord: { id: `70000${stamp}`, username: "no.mail", verified: false } });
	const namelessPage = await nameless.back.text();
	check("no verified email means no account", namelessPage.includes("no verified email") && (await sql`select 1 from users where email is null and screen_name = 'nomail'`).length === 0, namelessPage.match(/That didn't work[\s\S]{0,200}/)?.[0]);

	// the forgot-password form DMs the reset link to a linked account
	process.env.DISCORD_BOT_TOKEN = "bot-token";
	discordCalls = [];
	who = { id: `90000${stamp}` };
	await requestReset(account!.screen_name);
	const channel = discordCalls.find((c) => c.url.endsWith("/users/@me/channels"));
	const message = discordCalls.find((c) => c.url.endsWith("/channels/dm-1/messages"));
	const content = message ? String(JSON.parse(String(message.init!.body)).content) : "";
	check("a linked account is DMed its reset link", !!channel && !!message, discordCalls.map((c) => c.url));
	check("the DM carries a link, never a password", content.includes("/account/reset?token=") && !/password:\s*\S/.test(content), content.slice(0, 90));
	check("dmUser agrees it was sent", await dmUser(String(who.id), "x"));

	// deactivating yourself is undone by signing in with Discord, as it is with
	// a password, for thirty days
	who = { id: `90000${stamp}`, username: "Some.One" };
	await sql`update users set status = 'suspended', deactivated_at = now() where id = ${userId}::bigint`;
	const revived = await roundTrip();
	check(
		"a deactivated account is brought back by signing in",
		revived.back.status === 303 &&
			revived.back.headers.get("location") === "/home" &&
			(await sql`select 1 from users where id = ${userId}::bigint and status = 'active' and deactivated_at is null`).length === 1,
		revived.back.status,
	);
	await sql`update users set status = 'suspended', deactivated_at = now() - interval '40 days' where id = ${userId}::bigint`;
	const tooLate = await roundTrip();
	check("thirty days is the limit", tooLate.back.status === 400 && (await tooLate.back.text()).includes("more than thirty days"));
	await sql`update users set status = 'active', deactivated_at = null where id = ${userId}::bigint`;

} finally {
	globalThis.fetch = realFetch;
	delete process.env.DISCORD_BOT_TOKEN;
	if (created.length) await sql`delete from users where id = any(${sql.array(created, "INT8")})`;
	await sql.close();
}

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
