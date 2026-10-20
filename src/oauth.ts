// OAuth 2 authorization-code flow for public clients. PKCE is mandatory;
// client secrets and implicit grants are intentionally unsupported.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Viewer } from "./auth";
import { accountPage, esc } from "./account-page";
import { boundedBody } from "./api-input";
import { PUBLIC_ORIGIN } from "./config";
import { sql } from "./db";
import { isId, newId } from "./ids";
import { requestIp } from "./login-history";
import { hit, limitedResponse } from "./ratelimit";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const challengeFor = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");
const token = () => `xit_${randomBytes(24).toString("hex")}`;
const code = () => randomBytes(32).toString("base64url");
const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "POST, OPTIONS", "cache-control": "no-store" };
const oauthError = (error: string, status = 400) => Response.json({ error }, { status, headers: cors });

export function validRedirect(value: string): boolean {
	if (!value || value.length > 2048) return false;
	try {
		const url = new URL(value);
		if (url.hash || url.username || url.password || url.origin === "null") return false;
		return url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
	} catch { return false; }
}

async function form(req: Request, limit = 8192): Promise<FormData | undefined> {
	if (!(req.headers.get("content-type") ?? "").startsWith("application/x-www-form-urlencoded")) return undefined;
	try {
		const bytes = await boundedBody(req, limit);
		return await new Response(bytes, { headers: { "content-type": "application/x-www-form-urlencoded" } }).formData();
	} catch { return undefined; }
}

const value = (f: FormData, key: string) => String(f.get(key) ?? "");

export async function oauthToken(req: Request): Promise<Response> {
	if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
	if (req.method !== "POST") return oauthError("invalid_request", 405);
	const limit = hit("auth", requestIp(req) ?? "unknown");
	if (!limit.ok) return limitedResponse(limit);
	const f = await form(req);
	if (!f || value(f, "grant_type") !== "authorization_code") return oauthError("unsupported_grant_type");
	const clientId = value(f, "client_id"), givenCode = value(f, "code"), verifier = value(f, "code_verifier"), redirect = value(f, "redirect_uri");
	if (!isId(clientId) || !/^[A-Za-z0-9_-]{43}$/.test(givenCode) || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !validRedirect(redirect)) return oauthError("invalid_request");
	const result = await sql.begin(async (tx) => {
		// DELETE consumes the code even when the verifier or redirect is wrong.
		const [grant] = await tx`delete from oauth_codes where code_hash = ${digest(givenCode)} returning client_id::text, user_id::text, redirect_uri, scope, code_challenge, expires_at`;
		if (!grant || grant.client_id !== clientId || grant.redirect_uri !== redirect || new Date(grant.expires_at).getTime() <= Date.now()) return undefined;
		const expected = Buffer.from(grant.code_challenge), actual = Buffer.from(challengeFor(verifier));
		if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return undefined;
		const [account] = await tx`select u.id from users u join oauth_clients c on c.id = ${clientId}::bigint
			where u.id = ${grant.user_id}::bigint and u.status = 'active' and u.deactivated_at is null and u.instance is null and not c.revoked for update of u`;
		if (!account) return undefined;
		const access = token();
		await tx`delete from api_tokens where user_id = ${grant.user_id}::bigint and client_id = ${clientId}::bigint`;
		const issued = await tx`insert into api_tokens(id, user_id, name, token_hash, scope, client_id, expires_at)
			select ${newId()}::bigint, ${grant.user_id}::bigint, left(name, 40), ${digest(access)}, ${grant.scope}, id, now() + interval '30 days'
			from oauth_clients where id = ${clientId}::bigint and not revoked returning id`;
		if (!issued.length) return undefined;
		return { access_token: access, token_type: "Bearer", scope: grant.scope, expires_in: 30 * 24 * 3600 };
	});
	return result ? Response.json(result, { headers: cors }) : oauthError("invalid_grant");
}

type RequestData = { clientId: string; redirect: string; state: string; scope: "read" | "write"; challenge: string; name: string; owner: string };

async function authorization(values: URLSearchParams | FormData): Promise<RequestData | undefined> {
	const get = (key: string) => String(values.get(key) ?? "");
	const clientId = get("client_id"), redirect = get("redirect_uri"), state = get("state"), challenge = get("code_challenge");
	const scope = get("scope");
	if (get("response_type") !== "code" || get("code_challenge_method") !== "S256" || !isId(clientId) || !validRedirect(redirect) ||
		!/^[A-Za-z0-9_-]{43}$/.test(challenge) || state.length < 8 || state.length > 512 || !["read", "write"].includes(scope)) return undefined;
	const [client] = await sql`select c.name, c.redirect_uri, u.screen_name as owner from oauth_clients c join users u on u.id = c.owner_id
		where c.id = ${clientId}::bigint and not c.revoked and u.status = 'active'`;
	if (!client || client.redirect_uri !== redirect) return undefined;
	return { clientId, redirect, state, scope: scope as "read" | "write", challenge, name: client.name, owner: client.owner };
}

const redirectWith = (request: RequestData, params: Record<string, string>) => {
	const url = new URL(request.redirect);
	for (const [key, val] of Object.entries({ ...params, state: request.state })) url.searchParams.set(key, val);
	return new Response(null, { status: 303, headers: { location: url.toString(), "cache-control": "no-store", "referrer-policy": "no-referrer" } });
};

export async function oauthAuthorize(req: Request, url: URL, viewer: Viewer | undefined): Promise<Response> {
	if (!viewer) return new Response("Sign in, then reopen this authorization link.", { status: 401 });
	if (viewer.status !== "active") return new Response("This account cannot authorize apps.", { status: 403 });
	const f = req.method === "POST" ? await form(req) : undefined;
	if (req.method === "POST" && (!f || value(f, "csrf") !== viewer.csrf || (req.headers.get("origin") && req.headers.get("origin") !== PUBLIC_ORIGIN))) return new Response("Invalid authorization form.", { status: 403 });
	const request = await authorization(f ?? url.searchParams);
	if (!request) return new Response("Invalid app authorization request.", { status: 400 });
	if (f) {
		const limit = hit("auth", viewer.id);
		if (!limit.ok) return limitedResponse(limit);
		if (value(f, "decision") !== "approve") return redirectWith(request, { error: "access_denied" });
		const fresh = code();
		await sql.begin(async (tx) => {
			const [account] = await tx`select id from users where id = ${viewer.id}::bigint and status = 'active' and deactivated_at is null and instance is null for update`;
			if (!account) throw new Error("Account cannot authorize apps.");
			await tx`delete from oauth_codes where expires_at < now()`;
			await tx`insert into oauth_codes(code_hash, client_id, user_id, redirect_uri, scope, code_challenge, expires_at)
				values(${digest(fresh)}, ${request.clientId}::bigint, ${viewer.id}::bigint, ${request.redirect}, ${request.scope}, ${request.challenge}, now() + interval '5 minutes')`;
		});
		return redirectWith(request, { code: fresh });
	}
	const hidden = Object.entries({ response_type: "code", client_id: request.clientId, redirect_uri: request.redirect, state: request.state, scope: request.scope, code_challenge: request.challenge, code_challenge_method: "S256", csrf: viewer.csrf })
		.map(([key, val]) => `<input type="hidden" name="${key}" value="${esc(val)}">`).join("");
	return accountPage({ req, viewer, title: "Connect an app", referrer: "no-referrer", body: `<h1>Connect ${esc(request.name)}?</h1>
<p>Registered by @${esc(request.owner)}. After approval, the app will return to <code>${esc(request.redirect)}</code>.</p>
<p>${request.scope === "write" ? "This app can read your account and post, like, follow, and upload as you." : "This app can read what your account can see."}</p>
<p>You can remove access at <a href="/account/apps">Connected apps</a>. Access expires after 30 days.</p>
<form method="post">${hidden}<button name="decision" value="approve">Authorize</button> <button name="decision" value="deny" type="submit">Cancel</button></form>` });
}

async function appsPage(req: Request, viewer: Viewer, message = ""): Promise<Response> {
	const grants = await sql`select t.id::text, t.scope, t.created_at, t.last_used_at, t.expires_at, c.name, c.id::text as client_id
		from api_tokens t join oauth_clients c on c.id = t.client_id where t.user_id = ${viewer.id}::bigint order by t.created_at desc`;
	const hidden = `<input type="hidden" name="csrf" value="${esc(viewer.csrf)}">`;
	return accountPage({ req, viewer, title: "Connected apps", referrer: "same-origin", body: `<h1>Connected apps</h1><p>Apps authorized to use your account. Removing one takes effect immediately.</p>
${message ? `<p>${esc(message)}</p>` : ""}${grants.length ? grants.map((g) => `<div class="card split"><div><b>${esc(g.name)}</b><div class="dim">${g.scope === "write" ? "Read and write" : "Read only"} · expires ${esc(new Date(g.expires_at).toLocaleDateString())}</div></div><form method="post">${hidden}<input type="hidden" name="id" value="${g.id}"><button class="danger">Remove</button></form></div>`).join("") : `<p class="dim">No connected apps.</p>`}
<p><a href="/account/apps/developer">Register an app you are building</a></p>` });
}

export async function connectedAppsRoute(req: Request, viewer: Viewer): Promise<Response> {
	if (req.method !== "POST") return appsPage(req, viewer);
	const limit = hit("write", viewer.id);
	if (!limit.ok) return limitedResponse(limit);
	const f = await form(req);
	if (!f || value(f, "csrf") !== viewer.csrf || (req.headers.get("origin") && req.headers.get("origin") !== PUBLIC_ORIGIN)) return new Response("Invalid form.", { status: 403 });
	const id = value(f, "id");
	if (!isId(id)) return new Response("Invalid grant.", { status: 400 });
	await sql`delete from api_tokens where id = ${id}::bigint and user_id = ${viewer.id}::bigint and client_id is not null`;
	return appsPage(req, viewer, "App access removed.");
}

async function developerPage(req: Request, viewer: Viewer, message = ""): Promise<Response> {
	const clients = await sql`select id::text, name, redirect_uri, revoked from oauth_clients where owner_id = ${viewer.id}::bigint order by created_at desc`;
	const hidden = `<input type="hidden" name="csrf" value="${esc(viewer.csrf)}">`;
	return accountPage({ req, viewer, title: "Developer apps", referrer: "same-origin", body: `<h1>Developer apps</h1>
<p>Register a public app to use OAuth authorization-code with PKCE (S256). HTTPS redirect URLs and local loopback URLs are supported.</p>
${message ? `<p>${esc(message)}</p>` : ""}<form method="post">${hidden}<input type="hidden" name="action" value="register"><label>App name<input name="name" maxlength="80" required></label><label>Exact redirect URL<input name="redirect_uri" type="url" maxlength="2048" required></label><button>Register app</button></form>
${clients.map((c) => `<div class="card"><b>${esc(c.name)}</b><p>Client ID: <code>${c.id}</code></p><p>Redirect: <code>${esc(c.redirect_uri)}</code></p><p>${c.revoked ? "Revoked" : "Active"}</p>${c.revoked ? "" : `<form method="post">${hidden}<input type="hidden" name="action" value="revoke"><input type="hidden" name="id" value="${c.id}"><button class="danger">Revoke app</button></form>`}</div>`).join("")}
<p><a href="/api">API and OAuth documentation</a></p>` });
}

export async function developerAppsRoute(req: Request, viewer: Viewer): Promise<Response> {
	if (req.method !== "POST") return developerPage(req, viewer);
	const f = await form(req);
	if (!f || value(f, "csrf") !== viewer.csrf || (req.headers.get("origin") && req.headers.get("origin") !== PUBLIC_ORIGIN)) return new Response("Invalid form.", { status: 403 });
	if (viewer.status !== "active") return new Response("This account cannot register apps.", { status: 403 });
	const limit = hit("write", viewer.id);
	if (!limit.ok) return limitedResponse(limit);
	if (value(f, "action") === "revoke") {
		const id = value(f, "id");
		if (!isId(id)) return new Response("Invalid app.", { status: 400 });
		await sql.begin(async (tx) => {
			await tx`update oauth_clients set revoked = true where id = ${id}::bigint and owner_id = ${viewer.id}::bigint`;
			await tx`delete from api_tokens where client_id = ${id}::bigint and exists(select 1 from oauth_clients where id = ${id}::bigint and owner_id = ${viewer.id}::bigint)`;
			await tx`delete from oauth_codes where client_id = ${id}::bigint and exists(select 1 from oauth_clients where id = ${id}::bigint and owner_id = ${viewer.id}::bigint)`;
		});
		return developerPage(req, viewer, "App revoked.");
	}
	if (value(f, "action") !== "register") return new Response("Invalid action.", { status: 400 });
	const name = value(f, "name").trim(), redirect = value(f, "redirect_uri").trim();
	if (!name || [...name].length > 80 || !validRedirect(redirect)) return developerPage(req, viewer, "Use a name and an exact HTTPS or local loopback redirect URL.");
	const made = await sql.begin(async (tx) => {
		await tx`select id from users where id = ${viewer.id}::bigint for update`;
		const [{ count }] = await tx`select count(*)::int as count from oauth_clients where owner_id = ${viewer.id}::bigint and not revoked`;
		if (count >= 10) return false;
		await tx`insert into oauth_clients(id, owner_id, name, redirect_uri) values(${newId()}::bigint, ${viewer.id}::bigint, ${name}, ${redirect})`;
		return true;
	});
	return developerPage(req, viewer, made ? "App registered. Use its client ID to request authorization." : "You can have up to ten active apps.");
}
