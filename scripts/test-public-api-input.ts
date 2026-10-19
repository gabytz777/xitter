// Integration regression: DATABASE_URL must name a disposable local database.
// Runs the real public API with a temporary account and removes the fixture.
import assert from "node:assert/strict";
import { sql } from "../src/db";
import { newId } from "../src/ids";
import { createToken, publicApi } from "../src/public-api";

const database = new URL(process.env.DATABASE_URL ?? "postgres://localhost/xitter");
assert(["localhost", "127.0.0.1"].includes(database.hostname) && /test|codex/.test(database.pathname), "Use a disposable local test database.");
const id = newId();
await sql`insert into users (id, screen_name, name, password_hash) values (${id}::bigint, ${`api_input_${id}`}, 'API input regression', 'unusable')`;
try {
	const token = await createToken(id, "input regression", "write");
	const call = async (path: string, init: RequestInit = {}) => {
		const url = new URL(`https://example.test/api/v1${path}`);
		const headers = new Headers(init.headers);
		headers.set("authorization", `Bearer ${token}`);
		return publicApi(new Request(url, { ...init, headers }), url);
	};
	for (const length of [undefined, "1"]) {
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			pull(c) { c.enqueue(new Uint8Array(1024 * 1024)); },
			cancel() { cancelled = true; },
		});
		const headers: Record<string, string> = { "content-type": "application/json" };
		if (length) headers["content-length"] = length;
		const response = await call("/posts", { method: "POST", headers, body });
		assert.equal(response.status, 413);
		assert(cancelled);
	}
	const media = await call("/media", { method: "POST", headers: { "content-type": "image/png", "content-length": "999999999" }, body: "a" });
	assert.equal(media.status, 413);
	const overflow = await call("/posts/9999999999999999999");
	assert.equal(overflow.status, 404);
	const fractional = await call("/timeline?limit=1.5");
	assert.equal(fractional.status, 200);
	const valid = await call("/posts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "A valid bounded API request" }) });
	assert.equal(valid.status, 201);
	const created = (await valid.json()).data.id;
	assert.equal((await call(`/posts/${created}`, { method: "DELETE" })).status, 200);
	console.log("Public API regression passed: absent/false lengths, media cap, bigint overflow, fractional pagination, valid create/delete.");
} finally {
	await sql`delete from users where id = ${id}::bigint`;
	await sql.close();
}
