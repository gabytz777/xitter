// Actual server + PostgreSQL + ffmpeg regression. Use a migrated disposable DB.
// DATABASE_URL=postgres://localhost/xitter_test bun scripts/test-public-api-chunked-media.ts
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const database = new URL(process.env.DATABASE_URL ?? "postgres://localhost/xitter");
assert(["localhost", "127.0.0.1"].includes(database.hostname) && /test|codex/.test(database.pathname), "Use a disposable local test database.");
const dir = await mkdtemp(join(tmpdir(), "xitter-api-media-"));
process.env.MEDIA_DIR = join(dir, "media");
const { sql, migrate } = await import("../src/db");
const { newId } = await import("../src/ids");
await migrate();
const ids = [newId(), newId(), newId()];
const tokens: string[] = [];
for (const id of ids) {
	await sql`insert into users(id,screen_name,name,password_hash) values(${id}::bigint,${`media_${id}`},'Media regression','!')`;
	const token = `xit_${Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("hex")}`;
	const hash = new Bun.CryptoHasher("sha256").update(token).digest("hex");
	await sql`insert into api_tokens(id,user_id,name,token_hash,scope) values(${newId()}::bigint,${id}::bigint,'Media regression',${hash},'write')`;
	tokens.push(token);
}
const readToken = `xit_${Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("hex")}`;
await sql`insert into api_tokens(id,user_id,name,token_hash,scope) values(${newId()}::bigint,${ids[0]}::bigint,'Read regression',${new Bun.CryptoHasher("sha256").update(readToken).digest("hex")},'read')`;
// Reserve a free local port, then release it for the actual application server.
const probe = Bun.serve({ port: 0, fetch: () => new Response() });
const port = probe.port;
probe.stop(true);
const origin = `http://localhost:${port}`;
const server = Bun.spawn([process.execPath, "src/server.ts"], {
	cwd: join(import.meta.dir, ".."),
	env: { ...process.env, DATABASE_URL: database.href, PORT: String(port), PUBLIC_ORIGIN: origin, MEDIA_DIR: process.env.MEDIA_DIR, RATE_LIMITS: "on" },
	stdout: "pipe", stderr: "pipe",
});
const output = new Response(server.stdout).text();
const diagnostics = new Response(server.stderr).text();
const call = (path: string, init: RequestInit = {}, token = tokens[0]) => fetch(`${origin}/api/v1${path}`, { ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), authorization: `Bearer ${token}` } });
const json = (value: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
const begin = async (type: string, size: number, token = tokens[0]) => {
	const res = await call("/media/uploads", json({ media_type: type, total_bytes: size }), token);
	assert.equal(res.status, 201, await res.clone().text());
	assert(Number(res.headers.get("x-rate-limit-limit")) > 0);
	assert(Number(res.headers.get("x-rate-limit-remaining")) < Number(res.headers.get("x-rate-limit-limit")));
	const { data } = await res.json();
	assert.equal(data.max_segment_bytes, 5 * 1024 * 1024);
	assert.equal(data.expires_after_secs, 3600);
	return data.media_id as string;
};
try {
	const deadline = Date.now() + 15_000;
	while (true) {
		try { if ((await call("/me")).status === 200) break; } catch {}
		assert(Date.now() < deadline, "Application server failed to start");
		await Bun.sleep(50);
	}
	assert.equal((await call("/media/uploads", json({ media_type: "text/plain", total_bytes: 2 }))).status, 415);
	assert.equal((await call("/media/uploads", json({ media_type: "image/png", total_bytes: 0 }))).status, 400);
	assert.equal((await call("/media/uploads", json({ media_type: "video/mp4", total_bytes: 1024 * 1024 * 1024 }))).status, 413);
	assert.equal((await call("/media/uploads", json({ media_type: "image/png", total_bytes: 2 }), readToken)).status, 403);
	const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jrlsAAAAASUVORK5CYII=", "base64");
	const image = await begin("image/png", png.length);
	assert.equal((await call(`/media/${image}`, {}, tokens[1])).status, 404);
	assert.equal((await call(`/media/${image}/segments/0`, { method: "POST", body: png }, tokens[1])).status, 404);
	assert.equal((await call(`/media/${image}/finalize`, { method: "POST" }, tokens[1])).status, 404);
	assert.equal((await call(`/media/${image}/segments/0`, { method: "POST", body: png }, readToken)).status, 403);
	assert.equal((await call(`/media/${image}/segments/10001`, { method: "POST", body: png })).status, 400);
	assert.equal((await call(`/media/${image}/segments/0`, { method: "POST" })).status, 400);
	assert.equal((await call(`/media/${image}/segments/0`, { method: "POST", body: new Uint8Array(5 * 1024 * 1024 + 1) })).status, 413);
	const half = Math.floor(png.length / 2);
	assert.equal((await call(`/media/${image}/segments/1`, { method: "POST", body: png.subarray(half) })).status, 200);
	assert.equal((await call(`/media/${image}/finalize`, { method: "POST" })).status, 400, "an incomplete upload must stay resumable");
	assert.equal((await call(`/media/${image}/segments/0`, { method: "POST", body: png.subarray(0, half) })).status, 200);
	assert.equal((await call(`/media/${image}/segments/0`, { method: "POST", body: png.subarray(0, half) })).status, 200);
	assert.equal((await call(`/media/${image}/segments/2`, { method: "POST", body: "extra" })).status, 400);
	const uploading = (await (await call(`/media/${image}`, {}, readToken)).json()).data;
	assert.equal(uploading.processing, "uploading");
	assert.equal(uploading.received_bytes, png.length);
	assert.equal(uploading.total_bytes, png.length);
	assert.deepEqual(uploading.segments, [{ segment_index: 0, bytes: half }, { segment_index: 1, bytes: png.length - half }]);
	// Hold the real media insertion inside finalize so a second HTTP request
	// deterministically overlaps assembly and sees only its own processing state.
	const lock = Number(BigInt(image) % 2147483647n) + 1;
	const fn = `test_media_finalize_${image}`;
	const held = await sql.reserve();
	let finishing: Promise<Response> | undefined;
	try {
		await sql.unsafe(`create function ${fn}() returns trigger language plpgsql as $$ begin if NEW.id = ${image} then perform pg_advisory_xact_lock(${lock}); end if; return NEW; end $$`);
		await sql.unsafe(`create trigger ${fn} before insert on media for each row execute function ${fn}()`);
		await held`select pg_advisory_lock(${lock})`;
		finishing = call(`/media/${image}/finalize`, { method: "POST" });
		const waitingBy = Date.now() + 10_000;
		while (!(await sql`select 1 from pg_locks where locktype='advisory' and objid=${lock}::oid and not granted`).length) {
			assert(Date.now() < waitingBy, "Finalize never reached the insertion barrier");
			await Bun.sleep(10);
		}
		const concurrent = await call(`/media/${image}/finalize`, { method: "POST" });
		assert.equal(concurrent.status, 200);
		const state = (await concurrent.json()).data;
		assert.equal(state.processing, "pending");
		assert.equal(state.check_after_secs, 1);
		assert.equal((await call(`/media/${image}`)).status, 200);
		assert.equal((await call(`/media/${image}`, {}, tokens[1])).status, 404);
		assert.equal((await call(`/media/${image}/finalize`, { method: "POST" }, tokens[1])).status, 404);
		await held`select pg_advisory_unlock(${lock})`;
		assert.equal((await finishing).status, 200);
	} finally {
		await held`select pg_advisory_unlock(${lock})`; held.release();
		await finishing?.catch(() => undefined);
		await sql.unsafe(`drop trigger if exists ${fn} on media`);
		await sql.unsafe(`drop function if exists ${fn}()`);
	}
	assert.equal((await (await call(`/media/${image}/finalize`, { method: "POST" })).json()).data.processing, "succeeded", "finalization retries are safe");
	assert.equal((await (await call(`/media/${image}`)).json()).data.processing, "succeeded");
	assert.equal((await sql`select size from media where id=${image}::bigint`)[0].size, png.length);
	assert.equal((await call("/media", { method: "POST", headers: { "content-type": "image/png" }, body: png })).status, 201, "simple upload remains compatible");
	console.log("ok: HTTP ownership/scopes, type/size/index bounds, resumable metadata, retries and simple upload compatibility");
	// A valid MP4 with an ISO BMFF free box is larger than the server's 16MiB
	// single-request cap, without requiring a costly high-resolution encoder.
	const movie = join(dir, "large.mp4");
	const ffmpeg = Bun.spawn([process.env.FFMPEG ?? "ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=64x64:r=24", "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", movie], { stdout: "ignore", stderr: "pipe" });
	assert.equal(await ffmpeg.exited, 0, await new Response(ffmpeg.stderr).text());
	const free = Buffer.alloc(18 * 1024 * 1024);
	free.writeUInt32BE(free.length, 0); free.write("free", 4);
	await Bun.write(movie, Buffer.concat([Buffer.from(await Bun.file(movie).arrayBuffer()), free]));
	const file = Bun.file(movie);
	assert(file.size > 16 * 1024 * 1024);
	try {
		assert.equal((await call("/media", { method: "POST", headers: { "content-type": "video/mp4" }, body: file })).status, 413, "server request cap stays unchanged");
	} catch (e) {
		// Bun can close the connection before the client finishes sending the
		// oversized body; that transport rejection also enforces the same cap.
		assert(/EPIPE|ECONNRESET/.test(String(e)), String(e));
	}
	const video = await begin("video/mp4", file.size);
	for (let offset = 0, segment = 0; offset < file.size; offset += 5 * 1024 * 1024, segment++) {
		assert.equal((await call(`/media/${video}/segments/${segment}`, { method: "POST", body: file.slice(offset, offset + 5 * 1024 * 1024) })).status, 200);
	}
	assert.equal((await call(`/media/${video}/finalize`, { method: "POST" })).status, 200);
	const convertedBy = Date.now() + 30_000;
	let status: any;
	do {
		status = (await (await call(`/media/${video}`)).json()).data;
		assert.notEqual(status.processing, "failed", JSON.stringify(status.error));
		assert(Date.now() < convertedBy, "Video processing timed out");
		if (status.processing !== "succeeded") await Bun.sleep(50);
	} while (status.processing !== "succeeded");
	assert.equal((await sql`select state from media where id=${video}::bigint`)[0].state, "ready");
	console.log(`ok: ${file.size} byte MP4 uploaded across bounded HTTP segments and converted by real ffmpeg`);
	for (let i = 0; i < 8; i++) await begin("image/png", png.length, tokens[2]);
	assert.equal((await call("/media/uploads", json({ media_type: "image/png", total_bytes: png.length }), tokens[2])).status, 429);
	console.log("ok: existing eight-pending-uploads account limit remains enforced");
	let limited: Response | undefined;
	for (let i = 0; i < 160; i++) {
		const res = await call("/media/uploads", json({ media_type: "image/png", total_bytes: 0 }));
		if (res.status === 429) { limited = res; break; }
		assert.equal(res.status, 400);
	}
	assert(limited, "upload rate limit was not enforced");
	assert(Number(limited.headers.get("retry-after")) > 0);
	const retry = await call(`/media/${video}/finalize`, { method: "POST" });
	assert.equal(retry.status, 200, "chunk finalization uses the separate write bucket");
	assert(Number(retry.headers.get("x-rate-limit-limit")) > Number(limited.headers.get("x-rate-limit-limit")));
	assert.equal((await call(`/media/${video}`)).status, 200, "upload throttling does not prevent reading progress");
	console.log("ok: initialization uses upload limits, finalization uses write limits, and progress remains readable");
} finally {
	server.kill(); await server.exited;
	const errors = await diagnostics;
	const logs = await output;
	if (process.env.MEDIA_TEST_DEBUG) console.error(logs.slice(-3000));
	if (server.exitCode && server.signalCode !== "SIGTERM") console.error(errors.slice(-3000));
	for (const id of ids) await sql`delete from users where id=${id}::bigint`;
	await sql.close();
	await rm(dir, { recursive: true, force: true });
}
