// Real HTTP + DB resource-limit regression. Provider traffic is intercepted;
// no external requests, real uploads or expensive image/video jobs are needed.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const database = new URL(process.env.DATABASE_URL ?? "postgres://localhost/xitter");
assert(["localhost", "127.0.0.1"].includes(database.hostname) && /test|codex/.test(database.pathname), "Use a disposable local test database.");
const dir = mkdtempSync(join(tmpdir(), "xitter-upload-cap-")); process.env.MEDIA_DIR = dir;
const { sql } = await import("../src/db");
const { newId } = await import("../src/ids");
const { mediaUpload } = await import("../src/media");
const owner = newId(), other = newId(), sourceOwner = newId();
const server = Bun.serve({ port: 0, fetch(req) { return mediaUpload(req, new URL(req.url), { id: req.headers.get("x-viewer") ?? owner } as any); } });
const origin = `http://localhost:${server.port}`;
const nativeFetch = globalThis.fetch;
const download = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
let providerCalls = 0, blockProvider = true, validProvider = false;
const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
globalThis.fetch = (async (input, init) => {
 const url = String(input);
 if (url.startsWith(`${origin}/`)) return nativeFetch(input, init);
 assert.equal(url, "https://media.tenor.com/cap.gif", "No external network is permitted");
 providerCalls++;
 if (blockProvider) await download.promise;
 return new Response(validProvider ? gif : "not-a-gif", { headers: { "content-type": "image/gif" } });
}) as typeof fetch;
const call = (command: string, mediaId?: string, userId = owner, body?: FormData, extra: Record<string, string> = {}) => fetch(`${origin}/upload?${new URLSearchParams({ command, ...(mediaId ? { media_id: mediaId } : {}), ...extra })}`, { method: "POST", headers: { "x-viewer": userId }, body });
const init = (who = owner) => call("INIT", undefined, who, undefined, { media_type: "image/gif", total_bytes: String(gif.length) });
const source = (who = owner, url = "/i/api/xitter/gif?u=https%3A%2F%2Fmedia.tenor.com%2Fcap.gif") => call("INIT", undefined, who, undefined, { source_url: url });
const sourceRequests: Promise<Response>[] = [];
let holder: Promise<unknown> | undefined, finalizing: Promise<Response> | undefined;
try {
 for (const id of [owner, other, sourceOwner]) await sql`insert into users (id, screen_name, name, password_hash) values (${id}::bigint, ${`uploadcap_${id}`}, 'Upload cap', 'unusable')`;
 const ids: string[] = [];
 for (let i = 0; i < 8; i++) { const r = await init(); assert.equal(r.status, 202); ids.push((await r.json()).media_id_string); }
 assert.equal((await init()).status, 429);
 const form = new FormData(); form.set("media", new Blob([gif]));
 assert.equal((await call("APPEND", ids[0], owner, form, { segment_index: "0" })).status, 204);
 const locked = Promise.withResolvers<void>();
 holder = sql.begin(async (tx) => { await tx`select id from users where id = ${owner}::bigint for update`; locked.resolve(); await release.promise; });
 await locked.promise; finalizing = call("FINALIZE", ids[0]);
 const deadline = Date.now() + 10_000;
 while (!(await sql`select 1 from pg_stat_activity where datname = current_database() and wait_event = 'transactionid' and query like '%insert into media%'`).length) {
  assert(Date.now() < deadline, "Finalization did not reach barrier"); await Bun.sleep(10);
 }
 assert.equal((await init()).status, 429, "assembly still counts as active work");
 assert.equal((await source()).status, 429, "source URL uploads share the same cap"); assert.equal(providerCalls, 0);
 assert.equal((await init(other)).status, 202, "another account keeps its own capacity");
 release.resolve(); await holder; assert.equal((await finalizing).status, 200);
 assert.equal((await init()).status, 202, "completed assembly releases one slot");
 // Failing incomplete FINALIZE must also release its slot.
 assert.equal((await call("FINALIZE", ids[1])).status, 400);
 assert.equal((await init()).status, 202, "failed assembly releases its slot");
 console.log("ok: cap includes pending and finalizing uploads, isolates accounts and releases success/failure slots");
 for (let i = 0; i < 8; i++) sourceRequests.push(source(sourceOwner));
 const sourceDeadline = Date.now() + 10_000;
 while (providerCalls < 8) { assert(Date.now() < sourceDeadline, "Downloads did not reach provider barrier"); await Bun.sleep(10); }
 assert.equal((await source(sourceOwner)).status, 429, "downloads reserve capacity before awaiting provider");
 assert.equal((await init(sourceOwner)).status, 429, "normal uploads count in-flight source downloads");
 assert.equal(providerCalls, 8, "rejected requests never start upstream work");
 download.resolve();
 for (const response of await Promise.all(sourceRequests)) assert.equal(response.status, 400, "invalid provider data is refused");
 blockProvider = false;
 for (let i = 0; i < 9; i++) assert.equal((await source(sourceOwner, "/i/api/xitter/gif?u=https%3A%2F%2Funtrusted.invalid%2Fa.gif")).status, 400);
 validProvider = true;
 const successful = await source(sourceOwner); assert.equal(successful.status, 200, "failed downloads release reservations");
 const successId = (await successful.json()).media_id_string;
 assert.equal((await (await call("STATUS", successId, sourceOwner)).json()).processing_info.state, "succeeded");
 for (let i = 0; i < 8; i++) assert.equal((await init(sourceOwner)).status, 202, "completed source upload is not double counted or retained");
 assert.equal((await init(sourceOwner)).status, 429);
 console.log("ok: source download reservations cap upstream work, preserve trusted-source checks and release every refusal/completion");
} finally {
 release.resolve(); download.resolve(); await holder?.catch(() => undefined); await finalizing?.catch(() => undefined); await Promise.allSettled(sourceRequests);
 globalThis.fetch = nativeFetch; await server.stop(true);
 await sql`delete from users where id in (${owner}::bigint, ${other}::bigint, ${sourceOwner}::bigint)`;
 await sql.close(); rmSync(dir, { recursive: true, force: true });
}
