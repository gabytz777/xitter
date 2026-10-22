// What can be checked about Discord sign-in (discord.ts) without Discord or a
// database: the handle it would choose, the trip to discord.com and back, and
// the bot's DM. The flows that need accounts are in test-discord-login.ts.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PUBLIC_ORIGIN } from "../src/config";

// the routes only exist with these set; discordEnabled() reads them per call
process.env.DISCORD_CLIENT_ID = "123456789012345678";
process.env.DISCORD_CLIENT_SECRET = "shh";
process.env.DISCORD_BOT_TOKEN = "bot-token";

const { discordStart, discordCallback, dmUser, handleBase, discordEnabled } = await import("../src/discord");

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

type Call = { url: string; init?: RequestInit };
const stub = (answer: (url: string) => Response | undefined) => {
	const calls: Call[] = [];
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		calls.push({ url, init });
		return answer(url) ?? new Response("no", { status: 404 });
	}) as typeof fetch;
	return calls;
};

const cookiesOf = (res: Response): Record<string, string> =>
	Object.fromEntries(
		res.headers.getSetCookie().map((c) => {
			const [pair] = c.split(";");
			const at = pair!.indexOf("=");
			return [pair!.slice(0, at), pair!.slice(at + 1)];
		}),
	);
const cookieHeader = (jar: Record<string, string>) => Object.entries(jar).filter(([, v]) => v !== "").map(([k, v]) => `${k}=${v}`).join("; ");

const get = (path: string, cookie = "") => new Request(`${PUBLIC_ORIGIN}${path}`, { headers: cookie ? { cookie } : {} });

// the trip out, then back with a code, as the browser would do it. Discord
// names nobody here (no id), so the flow stops before it would need accounts:
// the rest is in test-discord-login.ts, which has a database.
async function trip(purpose = "", who: Record<string, unknown> = {}) {
	const out = discordStart(get(`/oauth/discord${purpose}`), new URL(`${PUBLIC_ORIGIN}/oauth/discord${purpose}`));
	const jar = cookiesOf(out);
	const state = new URL(out.headers.get("location")!).searchParams.get("state")!;
	const calls = stub((url) =>
		url.includes("/oauth2/token") ? Response.json({ access_token: "access" }) : url.endsWith("/users/@me") ? Response.json(who) : undefined,
	);
	const back = await discordCallback(get(`/oauth/discord/callback?code=the-code&state=${state}`, cookieHeader(jar)), new URL(`${PUBLIC_ORIGIN}/oauth/discord/callback?code=the-code&state=${state}`), null);
	return { out, back, calls, jar };
}

describe("the handle a Discord account gets", () => {
	test("is their username without what this instance refuses", () => {
		expect(handleBase("some.one")).toBe("someone");
		expect(handleBase("Cool_Name-99")).toBe("cool_name99");
		expect(handleBase("abcdefghijklmnopqrstuvwxyz")).toBe("abcdefghijklmno");
	});
	test("is never empty", () => {
		expect(handleBase("")).toBe("discord");
		expect(handleBase("....")).toBe("discord");
	});
});

describe("the trip to Discord", () => {
	test("needs both halves of the pair of credentials", () => {
		const secret = process.env.DISCORD_CLIENT_SECRET;
		delete process.env.DISCORD_CLIENT_SECRET;
		expect(discordEnabled()).toBe(false);
		process.env.DISCORD_CLIENT_SECRET = secret;
		expect(discordEnabled()).toBe(true);
	});

	test("starts at discord.com with PKCE and comes back here", () => {
		const res = discordStart(get("/oauth/discord"), new URL(`${PUBLIC_ORIGIN}/oauth/discord`));
		expect(res.status).toBe(302);
		const location = new URL(res.headers.get("location")!);
		expect(location.origin).toBe("https://discord.com");
		expect(location.pathname).toBe("/oauth2/authorize");
		expect(location.searchParams.get("client_id")).toBe("123456789012345678");
		expect(location.searchParams.get("redirect_uri")).toBe(`${PUBLIC_ORIGIN}/oauth/discord/callback`);
		expect(location.searchParams.get("scope")).toBe("identify email");
		expect(location.searchParams.get("code_challenge_method")).toBe("S256");
		expect(location.searchParams.get("code_challenge")!.length).toBeGreaterThan(40);
		expect(location.searchParams.get("state")!.length).toBe(32);
	});

	test("keeps the state and verifier in short-lived cookies", () => {
		const res = discordStart(get("/oauth/discord?purpose=reset"), new URL(`${PUBLIC_ORIGIN}/oauth/discord?purpose=reset`));
		const jar = cookiesOf(res);
		expect(jar.dc_state).toHaveLength(32);
		expect(jar.dc_verifier!.length).toBeGreaterThan(40);
		expect(jar.dc_purpose).toBe("reset");
		for (const cookie of res.headers.getSetCookie()) {
			expect(cookie).toContain("HttpOnly");
			expect(cookie).toContain("SameSite=Lax");
			expect(cookie).toContain("Max-Age=600");
		}
	});
});

describe("the answer from Discord", () => {
	test("without the cookie that started the trip is refused, and Discord is never asked", async () => {
		const calls = stub(() => Response.json({ access_token: "access" }));
		const url = new URL(`${PUBLIC_ORIGIN}/oauth/discord/callback?code=the-code&state=abc`);
		const res = await discordCallback(get("/oauth/discord/callback?code=the-code&state=abc"), url, null);
		expect(res.status).toBe(400);
		expect(await res.text()).toContain("another browser");
		expect(calls).toHaveLength(0);
	});

	test("with a state that doesn't match is refused", async () => {
		const first = discordStart(get("/oauth/discord"), new URL(`${PUBLIC_ORIGIN}/oauth/discord`));
		const jar = cookiesOf(first);
		const calls = stub(() => Response.json({ access_token: "access" }));
		const url = new URL(`${PUBLIC_ORIGIN}/oauth/discord/callback?code=the-code&state=${"0".repeat(32)}`);
		const res = await discordCallback(get(url.pathname + url.search, cookieHeader(jar)), url, null);
		expect(res.status).toBe(400);
		expect(calls).toHaveLength(0);
	});

	test("a cancelled sign-in is said plainly", async () => {
		const res = await discordCallback(get("/oauth/discord/callback?error=access_denied"), new URL(`${PUBLIC_ORIGIN}/oauth/discord/callback?error=access_denied`), null);
		expect(res.status).toBe(400);
		expect(await res.text()).toContain("didn't let the sign-in through");
	});

	test("exchanges the code with the verifier, then asks who it is", async () => {
		const { back, calls, jar } = await trip();
		expect(calls[0]!.url).toBe("https://discord.com/api/v10/oauth2/token");
		const form = new URLSearchParams(String(calls[0]!.init!.body));
		expect(form.get("grant_type")).toBe("authorization_code");
		expect(form.get("code")).toBe("the-code");
		expect(form.get("redirect_uri")).toBe(`${PUBLIC_ORIGIN}/oauth/discord/callback`);
		expect(form.get("code_verifier")).toBe(jar.dc_verifier!);
		expect(calls[1]!.url).toBe("https://discord.com/api/v10/users/@me");
		expect((calls[1]!.init!.headers as Record<string, string>).authorization).toBe("Bearer access");
		expect(back.status).toBeLessThan(500);
	});

	test("the cookies of the trip are cleared when it is over", async () => {
		const { back } = await trip();
		for (const cookie of back.headers.getSetCookie()) expect(cookie).toContain("Max-Age=0");
	});

	test("Discord refusing the exchange is a page, not a crash", async () => {
		const out = discordStart(get("/oauth/discord"), new URL(`${PUBLIC_ORIGIN}/oauth/discord`));
		const jar = cookiesOf(out);
		const state = new URL(out.headers.get("location")!).searchParams.get("state")!;
		stub(() => new Response("bad", { status: 400 }));
		const url = new URL(`${PUBLIC_ORIGIN}/oauth/discord/callback?code=the-code&state=${state}`);
		const res = await discordCallback(get(url.pathname + url.search, cookieHeader(jar)), url, null);
		expect(res.status).toBe(400);
		expect(await res.text()).toContain("wouldn't confirm");
	});
});

describe("the reset-link message", () => {
	test("is not sent without a bot token", async () => {
		const token = process.env.DISCORD_BOT_TOKEN;
		delete process.env.DISCORD_BOT_TOKEN;
		const calls = stub(() => Response.json({ id: "dm" }));
		expect(await dmUser("42", "hello")).toBe(false);
		expect(calls).toHaveLength(0);
		process.env.DISCORD_BOT_TOKEN = token;
	});

	test("opens a DM channel and writes the link into it", async () => {
		const calls = stub((url) => (url.endsWith("/users/@me/channels") ? Response.json({ id: "dm-1" }) : url.endsWith("/channels/dm-1/messages") ? Response.json({ id: "m-1" }) : undefined));
		expect(await dmUser("42", "the link")).toBe(true);
		expect(calls).toHaveLength(2);
		expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({ recipient_id: "42" });
		expect((calls[0]!.init!.headers as Record<string, string>).authorization).toBe("Bot bot-token");
		expect(JSON.parse(String(calls[1]!.init!.body))).toEqual({ content: "the link" });
	});

	test("a bot that shares no server with them reports failure", async () => {
		stub((url) => (url.endsWith("/users/@me/channels") ? Response.json({ message: "Cannot send messages to this user" }, { status: 403 }) : undefined));
		expect(await dmUser("42", "the link")).toBe(false);
	});
});
