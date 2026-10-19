// Browser push end to end against a stand-in push service: the subscription
// is registered through notifications/settings, a new follower is pushed
// (VAPID-signed, aes128gcm-encrypted for the subscriber's keys, which this
// script decrypts), switched-off kinds aren't, and a gone subscription is
// dropped. Only works on a localhost instance (push.ts takes local endpoints
// only there). Waits for the 15-second push timer. Cleans up.
// usage: bun scripts/test-push.ts <subscriber> <other> <password>

import { createDecipheriv, createECDH, hkdfSync, randomBytes } from "node:crypto";
import { sql } from "../src/db";

const origin = `http://localhost:${process.env.PORT ?? 3000}`;
const [subName, otherName, password] = process.argv.slice(2);
if (!password) throw new Error("usage: bun scripts/test-push.ts <subscriber> <other> <password>");

async function session(username: string) {
	const r = await fetch(`${origin}/login`, { method: "POST", body: new URLSearchParams({ username, password }), redirect: "manual" });
	const cookies = r.headers.getSetCookie().map((c) => c.split(";")[0]);
	const csrf = cookies.find((c) => c.startsWith("ct0="))?.slice(4);
	if (!csrf) throw new Error(`login ${username} failed`);
	const headers = { cookie: cookies.join("; "), "x-csrf-token": csrf };
	const post = async (path: string, body: object) =>
		(await fetch(`${origin}/i/api${path}`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) })).json();
	const form = (path: string, body: Record<string, string>) => fetch(`${origin}/i/api${path}`, { method: "POST", headers, body: new URLSearchParams(body) });
	const gql = async (op: string, variables: object) =>
		(await fetch(`${origin}/i/api/graphql/q/${op}`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ variables }) })).json();
	return { post, form, gql };
}
let failures = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : `: ${JSON.stringify(detail)}`}`);
}

// the subscriber's side: its keys, and RFC 8291 decryption
const ua = createECDH("prime256v1");
const uaPublic = ua.generateKeys();
const auth = randomBytes(16);
function decrypt(body: Buffer): any {
	const salt = body.subarray(0, 16);
	const idlen = body[20];
	const asPublic = body.subarray(21, 21 + idlen);
	const shared = ua.computeSecret(asPublic);
	const ikm = Buffer.from(hkdfSync("sha256", shared, auth, Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]), 32));
	const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
	const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
	const data = body.subarray(21 + idlen);
	const d = createDecipheriv("aes-128-gcm", cek, nonce);
	d.setAuthTag(data.subarray(data.length - 16));
	const plain = Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]);
	return JSON.parse(plain.subarray(0, plain.lastIndexOf(2)).toString());
}

// the stand-in push service
const received: { headers: Headers; body: Buffer }[] = [];
let answer = 201;
const service = Bun.serve({
	port: 0,
	async fetch(req) {
		received.push({ headers: req.headers, body: Buffer.from(await req.arrayBuffer()) });
		return new Response(null, { status: answer });
	},
});
const endpoint = `http://localhost:${service.port}/push/${Date.now()}`;
const waitFor = async (n: number, seconds = 25) => {
	for (let i = 0; i < seconds * 2 && received.length < n; i++) await Bun.sleep(500);
	return received.length >= n;
};

const sub = await session(subName);
const other = await session(otherName);
const [{ id: subId }] = await sql`select id::text from users where screen_name = ${subName}`;
const device = { token: endpoint, encryption_key1: uaPublic.toString("base64url"), encryption_key2: auth.toString("base64url"), checksum: "", env: 3, locale: "en", protocol_version: 1 };
const made: string[] = [];

try {
	check("a made-up push service is refused", !(await sql`select 1 from push_subscriptions where endpoint = 'https://evil.example/x'`).length &&
		!!(await sub.post("/1.1/notifications/settings/login.json", { push_device_info: { ...device, token: "https://evil.example/x" } })) && !(await sql`select 1 from push_subscriptions where endpoint = 'https://evil.example/x'`).length);
	const login = await sub.post("/1.1/notifications/settings/login.json", { push_device_info: device });
	check("subscribing answers the settings screen", login.push_settings?.followed === "on" && login.push_settings_template?.template?.settings?.[0]?.section_entries?.length > 0, login.push_settings);
	check("and keeps the subscription", (await sql`select 1 from push_subscriptions where endpoint = ${endpoint} and user_id = ${subId}::bigint`).length === 1);
	const saved = await sub.post("/1.1/notifications/settings/save.json", { push_device_info: { ...device, settings: { mentions: "off", nonsense: "on" } } });
	check("switches are saved", saved.push_settings.mentions === "off" && !("nonsense" in saved.push_settings), saved.push_settings);

	await sql`update push_subscriptions set last_pushed_at = now() where endpoint = ${endpoint}`;
	await other.form("/1.1/friendships/create.json", { user_id: subId });
	check("a new follower is pushed", await waitFor(1));
	const first = received[0];
	check("signed with VAPID", /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/.test(first?.headers.get("authorization") ?? ""), first?.headers.get("authorization")?.slice(0, 20));
	check("and encrypted for the browser", first?.headers.get("content-encoding") === "aes128gcm");
	const msg = first && decrypt(first.body);
	check("which reads the push", /followed you$/.test(msg?.body ?? "") && msg?.url === `/${otherName}`, msg);

	// a reply, with mentions switched off: nothing
	const [post] = await sql`insert into posts (id, user_id, text, conversation_id) values (${String(BigInt(Date.now()) << 22n)}::bigint, ${subId}::bigint, 'push test', ${String(BigInt(Date.now()) << 22n)}::bigint) returning id::text`;
	made.push(post.id);
	const reply = (await other.gql("CreateTweet", { tweet_text: "a reply", reply: { in_reply_to_tweet_id: post.id } })).data.create_tweet.tweet_results.result.rest_id;
	made.push(reply);
	check("a switched-off kind isn't pushed", !(await waitFor(2, 20)), received.length);

	answer = 410;
	await sub.post("/1.1/notifications/settings/save.json", { push_device_info: { ...device, settings: { mentions: "on" } } });
	await other.gql("FavoriteTweet", { tweet_id: post.id });
	await waitFor(2, 20);
	const gone = async () => !(await sql`select 1 from push_subscriptions where endpoint = ${endpoint}`).length;
	for (let i = 0; i < 20 && !(await gone()); i++) await Bun.sleep(250);
	check("a subscription the push service says is gone is dropped", await gone());
} finally {
	await other.form("/1.1/friendships/destroy.json", { user_id: subId });
	for (const id of made.reverse()) await sql`delete from posts where id = ${id}::bigint`;
	await sql`delete from push_subscriptions where endpoint = ${endpoint}`;
	service.stop(true);
}

console.log(failures ? `${failures} failed` : "all checks passed");
await sql.close();
process.exit(failures ? 1 : 0);
