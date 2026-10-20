// Direct OAuth flow checks against a migrated, disposable local database.
import { strict as assert } from "node:assert";
import { createHash, randomBytes } from "node:crypto";
import { sql } from "../src/db";
import { newId } from "../src/ids";
import type { Viewer } from "../src/auth";
import { connectedAppsRoute, developerAppsRoute, oauthAuthorize, oauthToken, validRedirect } from "../src/oauth";
import { publicApi } from "../src/public-api";
import { PUBLIC_ORIGIN } from "../src/config";

const database = new URL(process.env.DATABASE_URL ?? "postgres://localhost/xitter");
assert(["localhost", "127.0.0.1"].includes(database.hostname) && /test|codex/.test(database.pathname), "Use a disposable local test database.");

const developer = newId(), account = newId(), other = newId();
const viewer = (id: string) => ({ id, screen_name: `oauth_${id}`, status: "active", role: null, csrf: `csrf-${id}`, token: `session-${id}` }) as Viewer;
const appOwner = viewer(developer), user = viewer(account);
const redirect = "https://example.org/callback?source=xitter";
const origin = PUBLIC_ORIGIN;
const postForm = (path: string, fields: Record<string, string>) => new Request(`${origin}${path}`, { method: "POST", headers: { origin, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields) });

async function approve(clientId: string, scope: "read" | "write" = "read") {
	const verifier = randomBytes(32).toString("base64url");
	const challenge = createHash("sha256").update(verifier).digest("base64url");
	const args = { response_type: "code", client_id: clientId, redirect_uri: redirect, state: "random-state-123", scope, code_challenge: challenge, code_challenge_method: "S256" };
	const url = new URL(`${origin}/oauth/authorize?${new URLSearchParams(args)}`);
	assert.equal((await oauthAuthorize(new Request(url), url, user)).status, 200, "consent page opens");
	const res = await oauthAuthorize(postForm("/oauth/authorize", { ...args, csrf: user.csrf, decision: "approve" }), url, user);
	assert.equal(res.status, 303);
	const callback = new URL(res.headers.get("location")!);
	assert.equal(callback.searchParams.get("state"), args.state);
	assert.equal(callback.origin + callback.pathname, "https://example.org/callback");
	return { code: callback.searchParams.get("code")!, verifier };
}

const exchange = (clientId: string, grant: { code: string; verifier: string }, verifier = grant.verifier) => oauthToken(postForm("/oauth/token", {
	grant_type: "authorization_code", client_id: clientId, redirect_uri: redirect, code: grant.code, code_verifier: verifier,
}));

try {
	for (const id of [developer, account, other]) await sql`insert into users(id, screen_name, name, password_hash) values(${id}::bigint, ${`oauth_${id}`}, 'OAuth test', 'unused')`;
	assert(!validRedirect("http://example.org/callback"), "plain HTTP remote redirect rejected");
	assert(!validRedirect("https://example.org/callback#fragment"), "fragment rejected");
	assert(validRedirect("http://127.0.0.1:3210/callback"), "loopback redirect allowed");
	assert.equal((await developerAppsRoute(postForm("/account/apps/developer", { csrf: "wrong", action: "register", name: "Bad", redirect_uri: redirect }), appOwner)).status, 403, "registration needs CSRF");
	const registered = await developerAppsRoute(postForm("/account/apps/developer", { csrf: appOwner.csrf, action: "register", name: "Example app", redirect_uri: redirect }), appOwner);
	assert.equal(registered.status, 200);
	const [client] = await sql`select id::text from oauth_clients where owner_id = ${developer}::bigint`;
	assert(client?.id);
	const wrongRedirect = new URL(`${origin}/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: client.id, redirect_uri: "https://evil.example/callback", state: "random-state-123", scope: "read", code_challenge: createHash("sha256").update("a".repeat(43)).digest("base64url"), code_challenge_method: "S256" })}`);
	assert.equal((await oauthAuthorize(new Request(wrongRedirect), wrongRedirect, user)).status, 400, "unregistered redirect rejected");
	const bad = await approve(client.id);
	assert.equal((await exchange(client.id, bad, randomBytes(32).toString("base64url"))).status, 400, "wrong PKCE verifier rejected");
	assert.equal((await exchange(client.id, bad)).status, 400, "wrong verifier consumed the code");
	const grant = await approve(client.id);
	const tokenResponse = await exchange(client.id, grant);
	assert.equal(tokenResponse.status, 200);
	const issued = await tokenResponse.json();
	assert.equal(issued.scope, "read");
	assert.equal(issued.expires_in, 30 * 24 * 3600);
	assert.equal((await exchange(client.id, grant)).status, 400, "code cannot be replayed");
	const api = (method: string, path: string, token: string) => {
		const url = new URL(`${origin}/api/v1${path}`);
		return publicApi(new Request(url, { method, headers: { authorization: `Bearer ${token}` } }), url);
	};
	const me = await api("GET", "/me", issued.access_token);
	assert.equal((await me.json()).data.id, account, "app token accesses its user's account");
	assert.equal((await api("POST", "/posts", issued.access_token)).status, 403, "read grant cannot write");
	await sql`update api_tokens set expires_at = now() - interval '1 second' where user_id = ${account}::bigint and client_id = ${client.id}::bigint`;
	assert.equal((await api("GET", "/me", issued.access_token)).status, 401, "expired app token rejected");
	assert.equal((await connectedAppsRoute(postForm("/account/apps", { csrf: user.csrf, id: (await sql`select id::text from api_tokens where user_id = ${account}::bigint and client_id = ${client.id}::bigint`)[0].id }), user)).status, 200);
	assert.equal((await api("GET", "/me", issued.access_token)).status, 401, "user revocation takes effect");
	const writeGrant = await approve(client.id, "write");
	const writeToken = (await (await exchange(client.id, writeGrant)).json()).access_token;
	assert.equal((await developerAppsRoute(postForm("/account/apps/developer", { csrf: appOwner.csrf, action: "revoke", id: client.id }), appOwner)).status, 200);
	assert.equal((await api("GET", "/me", writeToken)).status, 401, "developer revocation takes effect");
	console.log("OAuth registration, consent, PKCE, scope, replay, and revocation checks passed");
} finally {
	await sql`delete from users where id in (${developer}::bigint, ${account}::bigint, ${other}::bigint)`;
	await sql.close();
}
