// Signing in with Discord — and, on this instance, resetting a password with
// it, since there is no mail: Discord is the only "it really is you" we have.
// OAuth2 authorization code with PKCE, against discord.com.
//
//   GET  /oauth/discord             start: state and PKCE in cookies, then off
//   GET  /oauth/discord/callback    the answer: sign in, link, create, or reset
//   GET  /account/discord           link or unlink it (signed in)
//   POST /account/discord/unlink
//   GET  /account/discord/confirm   the same trip, to confirm it is you
//
// DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET turn all of this on, and the
// routes are wired up only when they are set (server.ts): unset them and the
// feature does not exist. DISCORD_BOT_TOKEN is
// optional and only used for the reset-link DM (password-reset.ts): a bot can
// only write to people it shares a server with, so nothing here depends on it —
// the account switching over to Discord is the reliable way to reset, and the
// way to get past the screens that ask for the password (confirm, step-up.ts).
import { signInCookies } from "./accounts";
import { accountPage, esc } from "./account-page";
import { parseCookies, SECURE, startSession, type Viewer } from "./auth";
import { PUBLIC_ORIGIN } from "./config";
import { sql } from "./db";
import { isReserved, SignupError, signUp, usernameProblem } from "./invites";
import { requestIp } from "./login-history";
import { expireSanctions } from "./moderation";
import { issueResetToken } from "./reset-tokens";
import { hit } from "./ratelimit";
import { settings } from "./settings";
import { grantStepUp, stepUpActive } from "./step-up";
import { DISCORD } from "./tidy";

const AUTHORIZE = "https://discord.com/oauth2/authorize";
const API = "https://discord.com/api/v10";
const SCOPES = "identify email";
// the link is short-lived: it only has to survive one trip to Discord
const LEG = 10 * 60;

export const discordEnabled = () => !!process.env.DISCORD_CLIENT_ID && !!process.env.DISCORD_CLIENT_SECRET;
const redirectUri = () => `${PUBLIC_ORIGIN}/oauth/discord/callback`;
const randomHex = (bytes: number) => Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("hex");
const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

type DiscordUser = { id: string; username: string; global_name?: string | null; avatar?: string | null; email?: string | null; verified?: boolean };

const page = (req: Request, title: string, body: string, status = 200) => accountPage({ req, title, body, status });

const failure = (req: Request, message: string, status = 400) =>
	page(
		req,
		"Discord sign-in",
		`<h1>That didn't work</h1><p class="error">${esc(message)}</p>
<p class="dim">You can still <a href="/">sign in with your password</a>${settings().signup_mode === "open" ? ", or create an account" : ""}. Then link Discord in Settings, under Discord.</p>`,
		status,
	);

// cookies for the leg of the trip away; all cleared when we come back
const legCookies = (state: string, verifier: string, purpose: string, clear = false, next = "") => {
	const age = clear ? 0 : LEG;
	const base = `Path=/; Max-Age=${age}; HttpOnly; SameSite=Lax${SECURE}`;
	return [
		`dc_state=${clear ? "" : state}; ${base}`,
		`dc_verifier=${clear ? "" : verifier}; ${base}`,
		`dc_purpose=${clear ? "" : purpose}; ${base}`,
		`dc_next=${clear ? "" : next}; ${base}`,
	];
};

// a page here, never another site: the code screen links back to it
export const safeNext = (v: string | null): string => {
	const s = String(v ?? "");
	return /^\/[^/\\]/.test(s) && !s.startsWith("//") && s.length <= 200 ? s : "/account/discord";
};

// GET /oauth/discord[?purpose=reset]
export function discordStart(req: Request, url: URL): Response {
	const ip = requestIp(req) ?? "unknown";
	const limit = hit("auth", ip);
	if (!limit.ok) {
		// best effort sync-ish response; failure is async but start can be slow? keep simple
		const headers = new Headers({ "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
		return new Response("too many", { status: 429, headers });
	}
	const asked = url.searchParams.get("purpose");
	const purpose = asked === "reset" ? "reset" : asked === "stepup" ? "stepup" : "";
	const next = purpose === "stepup" ? safeNext(url.searchParams.get("next")) : "";
	const state = randomHex(16);
	const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
	const challenge = b64url(new Bun.CryptoHasher("sha256").update(verifier).digest());
	const query = new URLSearchParams({
		client_id: process.env.DISCORD_CLIENT_ID!,
		redirect_uri: redirectUri(),
		response_type: "code",
		scope: SCOPES,
		state,
		code_challenge: challenge,
		code_challenge_method: "S256",
	});
	const headers = new Headers({ location: `${AUTHORIZE}?${query}`, "cache-control": "no-store" });
	for (const c of legCookies(state, verifier, purpose, false, encodeURIComponent(next))) headers.append("set-cookie", c);
	return new Response(null, { status: 302, headers });
}

async function exchange(code: string, verifier: string): Promise<Response | undefined> {
	return fetch(`${API}/oauth2/token`, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: process.env.DISCORD_CLIENT_ID!,
			client_secret: process.env.DISCORD_CLIENT_SECRET!,
			grant_type: "authorization_code",
			code,
			redirect_uri: redirectUri(),
			code_verifier: verifier,
		}),
	}).catch(() => undefined);
}

async function me(accessToken: string): Promise<DiscordUser | undefined> {
	const res = await fetch(`${API}/users/@me`, { headers: { authorization: `Bearer ${accessToken}` } }).catch(() => undefined);
	if (!res?.ok) return undefined;
	return (await res.json().catch(() => undefined)) as DiscordUser | undefined;
}

type Link = { discordId: string; userId: string };

const linkOfDiscord = async (discordId: string): Promise<Link | undefined> => {
	const [row] = await sql`select user_id::text as "userId" from discord_accounts where discord_id = ${discordId}`;
	return row ? { discordId, userId: row.userId } : undefined;
};

// one Discord account per account here; a Discord account already used by
// somebody else is refused rather than moved
async function link(discordId: string, userId: string, who: DiscordUser): Promise<string | undefined> {
	return sql.begin(async (tx) => {
		const [theirs] = await tx`select user_id::text as "userId" from discord_accounts where discord_id = ${discordId}`;
		if (theirs && theirs.userId !== userId) return "That Discord account is already linked to another account here.";
		await tx`delete from discord_accounts where user_id = ${userId}::bigint`;
		await tx`insert into discord_accounts (discord_id, user_id, username, global_name, avatar)
			values (${discordId}, ${userId}::bigint, ${who.username.slice(0, 64)}, ${(who.global_name ?? "").slice(0, 64) || null}, ${who.avatar ?? null})`;
		return undefined;
	});
}

// a handle nobody here has, from their Discord username: under 16 letters,
// digits and underscores, which is all this instance allows
export const handleBase = (username: string) => username.toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 15) || "discord";

async function freeHandles(username: string): Promise<string[]> {
	const base = handleBase(username);
	const tries = [base, ...Array.from({ length: 8 }, (_, i) => `${base.slice(0, 15 - String(i + 1).length)}${i + 1}`), `d${randomHex(4)}`];
	const out: string[] = [];
	for (const name of tries) {
		if (usernameProblem(name) || isReserved(name)) continue;
		if ((await sql`select 1 from users where lower(screen_name) = lower(${name})`).length) continue;
		out.push(name);
		if (out.length >= 5) break;
	}
	return out;
}

async function createAccount(who: DiscordUser, req: Request): Promise<string> {
	const email = who.verified && who.email ? who.email : "";
	if (!email)
		throw new SignupError(
			"Your Discord account has no verified email, and an account here needs one. Add one to Discord, or sign up with the form and link Discord afterwards.",
		);
	const name = (who.global_name || who.username).replace(/\s+/g, " ").trim().slice(0, 50) || who.username;
	let reason = "That username isn't available.";
	for (const screenName of await freeHandles(who.username)) {
		try {
			return await signUp({
				code: "",
				screenName,
				name,
				email,
				// a Discord sign-up has no password yet: one nobody knows, so a
				// password can only arrive through a reset
				password: randomHex(32),
				emailVerified: true,
				source: "discord",
				ip: requestIp(req),
			});
		} catch (e) {
			if (!(e instanceof SignupError)) throw e;
			reason = e.message;
			// only a taken handle is worth another try; a taken email or a
			// closed instance is not
			if (!/username|invite/i.test(e.message)) break;
		}
	}
	throw new SignupError(reason);
}

async function signIn(req: Request, userId: string): Promise<Response> {
	const session = await startSession(userId);
	const headers = new Headers({ location: "/home", "cache-control": "no-store" });
	for (const c of await signInCookies(req, session)) headers.append("set-cookie", c);
	for (const c of legCookies("", "", "", true)) headers.append("set-cookie", c);
	return new Response(null, { status: 303, headers });
}

// GET /oauth/discord/callback
export async function discordCallback(req: Request, url: URL, viewer: Viewer | null): Promise<Response> {
	const clear = legCookies("", "", "", true);
	const answer = async (res: Response | Promise<Response>): Promise<Response> => {
		const r = await res;
		const headers = new Headers(r.headers);
		for (const c of clear) headers.append("set-cookie", c);
		return new Response(r.body, { status: r.status, statusText: r.statusText, headers });
	};
	const q = url.searchParams;
	if (q.get("error")) return await answer(failure(req, q.get("error_description") || "Discord didn't let the sign-in through."));
	const cookie = parseCookies(req);
	const state = q.get("state") ?? "";
	// the state cookie is what proves the answer belongs to a trip this browser
	// started: without it a stranger could hand us somebody else's code
	if (!state || !cookie.dc_state || state !== cookie.dc_state) return await answer(failure(req, "That sign-in took too long, or started in another browser. Try again."));
	const verifier = cookie.dc_verifier ?? "";
	const purpose = cookie.dc_purpose ?? "";
	let next = "/account/discord";
	try {
		next = safeNext(decodeURIComponent(cookie.dc_next ?? ""));
	} catch {}
	const code = q.get("code") ?? "";
	if (!code || !verifier) return await answer(failure(req, "Discord sent no code back. Try again."));

	const tokenRes = await exchange(code, verifier);
	if (!tokenRes?.ok) {
		// Discord's own word for what was wrong (invalid_client, invalid_grant,
		// invalid_redirect_uri...), on the page and in the log: the words above
		// it are too general to fix anything with
		const body = await tokenRes?.text().catch(() => "") ?? "";
		const why = /"error"\s*:\s*"([a-z_]+)"/.exec(body)?.[1];
		console.error("discord: token exchange failed", tokenRes?.status, why, body.slice(0, 200));
		return await answer(failure(req, `Discord wouldn't confirm the sign-in${why ? ` (${why})` : ""}. Try again.`));
	}
	const token = (await tokenRes.json().catch(() => undefined)) as { access_token?: string } | undefined;
	if (!token?.access_token) return await answer(failure(req, "Discord didn't send a token. Try again."));
	const who = await me(token.access_token);
	if (!who?.id) {
		console.error("discord: /users/@me refused the token");
		return await answer(failure(req, "Discord wouldn't say who you are. Try again."));
	}

	// "confirm with Discord": the round trip itself is the proof. It grants
	// fifteen minutes in which the password screens let this account through
	// (step-up.ts), then puts the browser back where it asked.
	if (purpose === "stepup") {
		if (!viewer) return await answer(failure(req, "Sign in first, then confirm."));
		const [mine] = await sql`select discord_id from discord_accounts where user_id = ${viewer.id}::bigint`;
		if (!mine) return await answer(failure(req, "No Discord account is linked here yet. Link one under Settings, then try again."));
		if (mine.discord_id !== who.id) return await answer(failure(req, "That is a different Discord account from the one linked here."));
		await grantStepUp(viewer.id);
		return await answer(new Response(null, { status: 303, headers: { location: next, "cache-control": "no-store" } }));
	}

	// signed in already: this trip links Discord to that account
	if (viewer) {
		const problem = await link(who.id, viewer.id, who);
		if (problem) return await answer(failure(req, problem));
		return await answer(new Response(null, { status: 303, headers: { location: "/account/discord", "cache-control": "no-store" } }));
	}

	const linked = await linkOfDiscord(who.id);

	// "forgot my password": Discord says who you are, so hand over the same
	// one-hour link the mail would have carried, without needing the mail
	if (purpose === "reset") {
		if (!linked) return await answer(failure(req, "That Discord account isn't linked to an account here, so it can't stand in for a password reset."));
		const token = await issueResetToken(linked.userId);
		return await answer(new Response(null, { status: 303, headers: { location: `/account/reset?token=${token}`, "cache-control": "no-store" } }));
	}

	if (linked) {
		// a sanction that has run out must not keep anyone out (auth.ts login
		// does this before every password sign-in too)
		await expireSanctions();
		const [u] = await sql`select status, deactivated_at from users where id = ${linked.userId}::bigint and instance is null`;
		if (!u) return await answer(failure(req, "That account can't sign in."));
		// deactivating yourself is undone by signing in again within thirty days,
		// exactly as signing in with a password does; a suspension by staff is not
		if (u.deactivated_at) {
			const back = await sql`update users set status = 'active', deactivated_at = null
				where id = ${linked.userId}::bigint and deactivated_at > now() - interval '30 days' returning id`;
			if (!back.length) return await answer(failure(req, "That account was deactivated more than thirty days ago, so it can't come back this way."));
		} else if (u.status === "suspended") return await answer(failure(req, "That account is suspended."));
		return signIn(req, linked.userId);
	}

	// nobody here has this Discord account yet: make one, if this instance is
	// taking sign-ups at this moment
	if (settings().operations.maintenance) return await answer(failure(req, "This instance is under maintenance. Sign-ups will be back shortly."));
	if (settings().signup_mode !== "open")
		return answer(
			failure(req, `This instance isn't taking new sign-ups${settings().signup_mode === "invite" ? " without an invite" : ""}, so a Discord account can only sign in to one that already exists.`),
		);
	try {
		const userId = await createAccount(who, req);
		const problem = await link(who.id, userId, who);
		if (problem) return await answer(failure(req, problem));
		return signIn(req, userId);
	} catch (e) {
		if (e instanceof SignupError) return answer(failure(req, e.message));
		throw e;
	}
}

// the settings page: what is linked, and the way in and out
export async function discordAccountRoute(req: Request, url: URL, viewer: Viewer): Promise<Response> {
	if (req.method === "POST" && url.pathname === "/account/discord/unlink") {
		const form = await req.formData().catch(() => undefined);
		if (String(form?.get("csrf") ?? "") !== viewer.csrf) return new Response("That form is out of date. Go back and try again.", { status: 403 });
		await sql`delete from discord_accounts where user_id = ${viewer.id}::bigint`;
		return new Response(null, { status: 303, headers: { location: "/account/discord" } });
	}
	// A password to use where a screen insists on one — changing the email,
	// adding a passkey, moving the account — for an account that signed up
	// through Discord and so has a password nobody knows. No old password to
	// ask for, so this hands over the same one-hour link a reset would: the
	// reset form then replaces the password and signs every device out.
	if (req.method === "POST" && url.pathname === "/account/discord/password") {
		const form = await req.formData().catch(() => undefined);
		if (String(form?.get("csrf") ?? "") !== viewer.csrf) return new Response("That form is out of date. Go back and try again.", { status: 403 });
		const token = await issueResetToken(viewer.id);
		return new Response(null, { status: 303, headers: { location: `/account/reset?token=${token}`, "cache-control": "no-store" } });
	}

	const [row] = await sql`select discord_id, username, global_name, created_at from discord_accounts where user_id = ${viewer.id}::bigint`;
	const when = (d: Date) => d.toLocaleDateString("en", { year: "numeric", month: "short", day: "numeric" });
	const linked = row
		? `<div class="card"><p><strong>${esc(row.global_name || row.username || "Discord account")}</strong></p>
<p class="meta">${esc(row.username ? `@${row.username}` : "Discord")} · linked ${when(row.created_at)}</p>
<form method="post" action="/account/discord/unlink" onsubmit="return confirm('Unlink Discord? You will need your password to sign in, and you will not be able to reset it with Discord any more.')"><input type="hidden" name="csrf" value="${esc(viewer.csrf)}"><button class="secondary" type="submit">Unlink Discord</button></form></div>`
		: `<p>No Discord account is linked yet.</p>
<p><a href="/oauth/discord"><button type="button">Link Discord</button></a></p>`;

	const password = `<div class="card"><p><strong>Password</strong></p>
<p class="meta">The pinned client asks for your password in its own dialogs, for changing it and for turning the account off. If you signed up with Discord you have one but nobody knows it — not even you — so set one here to use those.</p>
<form method="post" action="/account/discord/password" onsubmit="return confirm('Choose a new password now? This signs out every device, including this one, and removes your passkeys. Sign back in with the new password.')"><input type="hidden" name="csrf" value="${esc(viewer.csrf)}"><button class="secondary" type="submit">Set a password</button></form></div>`;

	const confirmed = await stepUpActive(viewer.id);
	const confirm = `<div class="card"><p><strong>Confirming with Discord</strong></p>
<p class="meta">Screens that ask for your password — changing your email, adding a passkey, making a migration code — take a Confirm with Discord button instead. Press it there and you come straight back, let through for fifteen minutes. Nothing to copy, and no message has to arrive.</p>
${confirmed ? `<p class="dim">Confirmed just now: those screens will let you through for a few more minutes.</p>` : ""}
<form method="get" action="/account/discord/confirm"><input type="hidden" name="next" value="/account/discord"><button class="secondary" type="submit">Confirm with Discord for 15 minutes</button></form></div>`;

	return page(
		req,
		"Discord",
		`<h1>Discord</h1>
${linked}
<p class="dim">Linking Discord lets you sign in with it instead of your password, and reset your password with it when you forget it: this instance sends no mail, so without Discord a forgotten password can only be reset by staff.</p>
<p class="dim">Signing in with Discord shares your Discord username, display name and verified email with ${esc(settings().instance_name)}. Nothing is posted to Discord.</p>
${confirm}
${password}`,
	);
}

// the bot, for the reset link. Best effort: a bot can only open a DM with
// someone it shares a server with, and Discord answers 403 otherwise.
export async function dmUser(discordId: string, content: string): Promise<boolean> {
	const bot = process.env.DISCORD_BOT_TOKEN;
	if (!bot) return false;
	const headers = { authorization: `Bot ${bot}`, "content-type": "application/json" };
	const channel = await fetch(`${API}/users/@me/channels`, { method: "POST", headers, body: JSON.stringify({ recipient_id: discordId }) }).catch(() => undefined);
	if (!channel?.ok) return false;
	const { id } = (await channel.json().catch(() => ({}))) as { id?: string };
	if (!id) return false;
	const sent = await fetch(`${API}/channels/${id}/messages`, { method: "POST", headers, body: JSON.stringify({ content }) }).catch(() => undefined);
	return !!sent?.ok;
}

// The sign-in dialog (X's own, from the pinned client) gets a Discord button
// above the username field, next to the passkey one. A link, not a form: the
// trip happens on discord.com and comes back to /oauth/discord/callback.
export const DISCORD_SCRIPT = `(function(){
	if(!${discordEnabled()}) return;
	function separator(light){
		var line=light?"rgb(207, 217, 222)":"rgb(47, 51, 54)";
		var or=document.createElement("div");
		or.setAttribute("data-xitter-discord-or","");
		or.style.cssText="display:flex;align-items:center;gap:8px;margin:12px 0 8px;color:"+(light?"rgb(15, 20, 25)":"rgb(231, 233, 234)")+";font-size:15px;line-height:20px";
		or.innerHTML='<div style="flex:1;height:1px;background:'+line+'"></div><span>or</span><div style="flex:1;height:1px;background:'+line+'"></div>';
		return or;
	}
	function look(){
		// the sign-in dialog's username field: X marks it for passkeys, and
		// name="text" with autocomplete="username" is the older shape
		var field=document.querySelector('input[autocomplete~="webauthn"],input[name="text"][autocomplete~="username"]');
		if(!field)return;
		var label=field.closest("label")||field;
		var block=label.parentElement;
		if(!block)return;
		var light=getComputedStyle(document.body).backgroundColor==="rgb(255, 255, 255)";
		var parent=block.parentElement;
		var box=parent.querySelector("[data-xitter-discord]");
		if(!box){
			box=document.createElement("div");
			box.setAttribute("data-xitter-discord","");
			box.style.cssText="display:flex;flex-direction:column;box-sizing:border-box;width:100%;margin:0 0 4px;align-self:flex-start";
			var a=document.createElement("a");
			a.href="/oauth/discord";
			a.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true" style="width:20px;height:20px;margin-right:8px;fill:currentColor;flex:none"><path d="${DISCORD}"/></svg><span>Continue with Discord</span>';
			a.style.cssText="display:flex;align-items:center;justify-content:center;box-sizing:border-box;width:100%;min-height:40px;padding:0 16px;border-radius:9999px;border:1px solid #5865f2;background:#5865f2;color:#fff;font:inherit;font-size:15px;font-weight:700;line-height:20px;text-decoration:none;cursor:pointer;transition:background-color .2s";
			a.addEventListener("mouseenter",function(){a.style.backgroundColor="#4752c4"});
			a.addEventListener("mouseleave",function(){a.style.backgroundColor="#5865f2"});
			box.appendChild(a);
			// above the passkey button when that one got here first, so the two
			// read as one column: Discord, passkey, then the password
			parent.insertBefore(box,parent.querySelector("[data-xitter-passkey]")||block);
			var fit=function(){
				var f=label.getBoundingClientRect(),p=box.parentElement&&box.parentElement.getBoundingClientRect();
				if(!p||!f.width)return;
				box.style.width=f.width+"px";
				box.style.marginLeft=(f.left-p.left-parseFloat(getComputedStyle(box.parentElement).paddingLeft||"0"))+"px";
			};
			fit();
			if(window.ResizeObserver)new ResizeObserver(fit).observe(label);
		}
		// One "or" before the manual sign-in, not one between the buttons: the
		// passkey button brings its own (see passkeys.ts) when it is there, and
		// this one is only for when it is not
		var passkey=parent.querySelector("[data-xitter-passkey]");
		var mine=box.querySelector("[data-xitter-discord-or]");
		if(passkey){
			if(mine)mine.remove();
			// room to breathe between the two buttons; without it they read as
			// one control with a seam
			box.style.marginBottom="12px";
		}else{
			if(!mine)box.appendChild(separator(light));
			// the divider inside already carries the gap
			box.style.marginBottom="4px";
		}
	}
	new MutationObserver(look).observe(document.documentElement,{childList:true,subtree:true});
	look();
})();`;
