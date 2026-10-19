// Deterministic HTTP regression: hold the media INSERT at its FK lock while
// querying and retrying FINALIZE. Uses a disposable database, no external media.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const database = new URL(process.env.DATABASE_URL ?? "postgres://localhost/xitter");
assert(["localhost", "127.0.0.1"].includes(database.hostname) && /test|codex/.test(database.pathname), "Use a disposable local test database.");
const dir = mkdtempSync(join(tmpdir(), "xitter-finalization-"));
process.env.MEDIA_DIR = dir;
const { sql } = await import("../src/db");
const { newId } = await import("../src/ids");
const { mediaUpload } = await import("../src/media");
const owner = newId(), other = newId();
const server = Bun.serve({ port: 0, fetch(req) { return mediaUpload(req, new URL(req.url), { id: req.headers.get("x-viewer") ?? owner } as any); } });
const call = (command: string, mediaId?: string, userId = owner, body?: FormData, extra: Record<string, string> = {}) => fetch(`http://localhost:${server.port}/upload?${new URLSearchParams({ command, ...(mediaId ? { media_id: mediaId } : {}), ...extra })}`, { method: "POST", headers: { "x-viewer": userId }, body });
let holder: Promise<unknown> | undefined, finalizing: Promise<Response> | undefined;
const release = Promise.withResolvers<void>();
try {
 for (const id of [owner, other]) await sql`insert into users (id, screen_name, name, password_hash) values (${id}::bigint, ${`finalize_${id}`}, 'Finalize test', 'unusable')`;
 const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jrlsAAAAASUVORK5CYII=", "base64");
 const initial = await call("INIT", undefined, owner, undefined, { media_type: "image/png", total_bytes: String(png.length) });
 assert.equal(initial.status, 202);
 const id = (await initial.json()).media_id_string;
 const form = new FormData(); form.set("media", new Blob([png]));
 assert.equal((await call("APPEND", id, owner, form, { segment_index: "0" })).status, 204);
 const locked = Promise.withResolvers<void>();
 holder = sql.begin(async (tx) => {
  await tx`select id from users where id = ${owner}::bigint for update`;
  locked.resolve(); await release.promise;
 });
 await locked.promise;
 finalizing = call("FINALIZE", id);
 const deadline = Date.now() + 10_000;
 while (!(await sql`select 1 from pg_stat_activity where datname = current_database() and wait_event = 'transactionid' and query like '%insert into media%'`).length) {
  assert(Date.now() < deadline, "Finalization did not reach media INSERT barrier"); await Bun.sleep(10);
 }
 const status = await call("STATUS", id);
 assert.equal(status.status, 200, "STATUS must remain available during assembly");
 assert.equal((await status.json()).processing_info.state, "pending");
 const retry = await call("FINALIZE", id);
 assert.equal(retry.status, 200, "concurrent FINALIZE must not report an unknown upload");
 assert.equal((await retry.json()).processing_info.state, "pending");
 assert.equal((await call("STATUS", id, other)).status, 404);
 assert.equal((await call("FINALIZE", id, other)).status, 404);
 release.resolve(); await holder;
 assert.equal((await finalizing).status, 200);
 assert.equal((await (await call("STATUS", id)).json()).processing_info.state, "succeeded");
 assert.equal((await sql`select count(*)::int as n from media where id = ${id}::bigint`)[0].n, 1);
 console.log("HTTP finalization STATUS continuity, concurrent retry, ownership and exactly-once storage passed");
} finally {
 release.resolve(); await holder?.catch(() => undefined); await finalizing?.catch(() => undefined);
 await server.stop(true);
 await sql`delete from users where id in (${owner}::bigint, ${other}::bigint)`;
 await sql.close(); rmSync(dir, { recursive: true, force: true });
}
