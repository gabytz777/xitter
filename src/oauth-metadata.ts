// OAuth client ID metadata documents (draft-ietf-oauth-client-id-metadata-document):
// an app can use the https URL of a JSON document it hosts as its client_id,
// instead of registering a client on every instance. The document names the
// app and lists its redirect URLs, so one app signs in on any Xitter in one tap.
import { type RequestOptions, get } from "node:https";
import { type LookupFunction, isIP } from "node:net";
import { PUBLIC_ORIGIN } from "./config";
import { reservedAddress, resolver } from "./public-net";

export type ClientMetadata = { url: string; name: string; redirects: string[]; logo: string | null };

const MAX_BYTES = 16 * 1024;
const TTL = 5 * 60_000, FAILED_TTL = 60_000;
const cache = new Map<string, { at: number; doc: ClientMetadata | undefined }>();

// a client_id that names a metadata document: https, a path, no query,
// fragment, credentials or port
export function metadataClientId(value: string): URL | undefined {
	if (!value.startsWith("https://") || value.length > 512) return undefined;
	try {
		const url = new URL(value);
		if (url.href !== value || url.search || url.hash || url.username || url.password || url.port || url.pathname === "/") return undefined;
		if (isIP(url.hostname.replace(/^\[|\]$/g, "")) || !url.hostname.includes(".") || /\.(local|localhost|internal|lan|home\.arpa)$/i.test(url.hostname)) return undefined;
		return url;
	} catch {
		return undefined;
	}
}

// the server never fetches a client document from a reserved address (public-net.ts)
export { resolver };

// The connection's own DNS lookup: it refuses a name with any reserved
// address and connects to an address it just checked, so a host can't pass
// the check and then answer with a private address for the connection
export const publicLookup: LookupFunction = (host, options, callback) => {
	resolver.lookup(host).then(
		(addresses) => {
			if (!addresses.length || !addresses.every((a) => !reservedAddress(a.address)))
				return callback(Object.assign(new Error(`${host} isn't a public address`), { code: "ENOTFOUND" }), "", 0);
			const usable = options.family ? addresses.filter((a) => a.family === options.family) : addresses;
			if (!usable.length) return callback(Object.assign(new Error(`${host} has no usable address`), { code: "ENOTFOUND" }), "", 0);
			if (options.all) return (callback as unknown as (e: null, a: typeof usable) => void)(null, usable);
			callback(null, usable[0]!.address, usable[0]!.family);
		},
		(error) => callback(error, "", 0),
	);
};

// GET over HTTPS through publicLookup: no redirects, 5 seconds, 16 KB; the
// body only for a 200. Tests swap it out, or pass options to reach a local
// test server.
export const fetcher = {
	get: (url: string, test: RequestOptions = {}) =>
		new Promise<string | undefined>((resolve) => {
			const req = get(url, { lookup: publicLookup, headers: { accept: "application/json" }, timeout: 5000, ...test }, (res) => {
				if (res.statusCode !== 200 || Number(res.headers["content-length"] ?? 0) > MAX_BYTES) {
					res.destroy();
					return resolve(undefined);
				}
				const chunks: Buffer[] = [];
				let size = 0;
				res.on("data", (chunk: Buffer) => {
					size += chunk.length;
					if (size > MAX_BYTES) {
						res.destroy();
						return resolve(undefined);
					}
					chunks.push(chunk);
				});
				res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
				res.on("error", () => resolve(undefined));
			});
			req.on("timeout", () => req.destroy());
			req.on("error", () => resolve(undefined));
			// the timeout above is per idle socket; this bounds the whole request
			setTimeout(() => {
				req.destroy();
				resolve(undefined);
			}, 5000).unref();
		}),
};

function parse(url: string, text: string): ClientMetadata | undefined {
	let doc: Record<string, unknown>;
	try {
		doc = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!doc || typeof doc !== "object" || doc.client_id !== url) return undefined;
	// public clients only: no secrets to hold, PKCE does the proving
	if (doc.token_endpoint_auth_method !== undefined && doc.token_endpoint_auth_method !== "none") return undefined;
	if (!Array.isArray(doc.redirect_uris) || !doc.redirect_uris.length || doc.redirect_uris.length > 10) return undefined;
	// redirects stay on the document's own host, so a document can't send
	// codes to a site it doesn't control
	const host = new URL(url).hostname;
	const redirects = doc.redirect_uris.filter((r): r is string => {
		if (typeof r !== "string" || !r.startsWith("https://") || r.length > 2048) return false;
		try {
			const u = new URL(r);
			return u.hostname === host && !u.hash && !u.username && !u.password;
		} catch {
			return false;
		}
	});
	if (!redirects.length) return undefined;
	// logo_uri: shown as the app's icon, so like the redirects it stays on the
	// document's own host
	let logo: string | null = null;
	if (typeof doc.logo_uri === "string" && doc.logo_uri.startsWith("https://") && doc.logo_uri.length <= 2048) {
		try {
			const u = new URL(doc.logo_uri);
			if (u.hostname === host && !u.username && !u.password) logo = u.href;
		} catch {}
	}
	const raw = typeof doc.client_name === "string" ? doc.client_name.replace(/\p{Cc}/gu, "").trim() : "";
	const name = raw && [...raw].length <= 80 ? raw : host;
	return { url, name, redirects, logo };
}

// the app's metadata document, fetched (and kept five minutes, a failure one), or undefined
// when it can't be used
export async function clientMetadata(clientId: string): Promise<ClientMetadata | undefined> {
	const url = metadataClientId(clientId);
	if (!url) return undefined;
	const hit = cache.get(url.href);
	if (hit && Date.now() - hit.at < (hit.doc ? TTL : FAILED_TTL)) return hit.doc;
	const text = await fetcher.get(url.href).catch(() => undefined);
	const doc = text === undefined ? undefined : parse(url.href, text);
	if (cache.size > 500) cache.clear();
	cache.set(url.href, { at: Date.now(), doc });
	return doc;
}

// RFC 8414 server metadata: tells apps where to send people, and that a
// metadata document URL works as a client_id here
export function authorizationServerMetadata(): Response {
	return Response.json(
		{
			issuer: PUBLIC_ORIGIN,
			authorization_endpoint: `${PUBLIC_ORIGIN}/oauth/authorize`,
			token_endpoint: `${PUBLIC_ORIGIN}/oauth/token`,
			response_types_supported: ["code"],
			grant_types_supported: ["authorization_code"],
			code_challenge_methods_supported: ["S256"],
			token_endpoint_auth_methods_supported: ["none"],
			scopes_supported: ["read", "write"],
			client_id_metadata_document_supported: true,
		},
		{ headers: { "access-control-allow-origin": "*", "cache-control": "public, max-age=3600" } },
	);
}
