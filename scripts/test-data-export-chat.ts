// Real PostgreSQL E2EE archive regression. Main pool=1; a separate controller
// changes visibility after a staging batch to exercise the final authorization.
import assert from "node:assert/strict";
import { SQL } from "bun";
import { sql } from "../src/db";
import { newId } from "../src/ids";
import { dataExportRoute } from "../src/data-export";
import type { Viewer } from "../src/auth";
import * as thrift from "../src/thrift";
const database = new URL(process.env.DATABASE_URL ?? "postgres://localhost/xitter");
assert(["localhost", "127.0.0.1"].includes(database.hostname) && /test|codex/.test(database.pathname), "Use a disposable local test database.");
const control = new SQL(database.href, { max: 1 });
const owner = newId(), peer = newId(), stranger = newId();
const viewer = { id: owner, screen_name: `chat_export_${owner}` } as Viewer;
const shared = `shared_${owner}`, foreign = `foreign_${owner}`, cutoff = `cutoff_${owner}`, removed = `removed_${owner}`;
const nativeBegin = sql.begin.bind(sql);
const exportRoute = async (method: string, path = "/1.1/account/user_twitter_data") => {
 const response = await dataExportRoute(method, path, viewer, new Request("http://localhost/")); assert(response); return response;
};
const encoded = (kind: number, payload: string | Uint8Array, siblingKey = false) => Buffer.from(thrift.encode({
 5: thrift.str("OUTER_CONVERSATION_TOKEN"),
 7: thrift.struct({ [kind]: thrift.struct({ 100: typeof payload === "string" ? thrift.str(payload) : thrift.bin(payload) }), ...(siblingKey ? { 3: thrift.struct({ 1: thrift.str("WRAPPED_KEY_SECRET") }) } : {}) }),
 9: thrift.struct({ 4: thrift.str("SIGNING_KEY_SENTINEL") }),
}));
async function event(conversation = shared, sender = peer, kind = 1, payload: string | Uint8Array = "CIPHERTEXT", options: { audience?: string; deleted?: boolean; siblingKey?: boolean; raw?: Buffer } = {}) {
 const seq = newId();
 await sql`insert into chat_events (seq, conversation_id, sender_id, kind, event, audience_id, deleted)
  values (${seq}::bigint, ${conversation}, ${sender}::bigint, ${kind}, ${options.raw ?? encoded(kind, payload, options.siblingKey)}, ${options.audience ?? null}::bigint, ${options.deleted ?? false})`;
 return seq;
}
try {
 for (const id of [owner, peer, stranger]) await sql`insert into users (id, screen_name, name, password_hash) values (${id}::bigint, ${`ce_${id}`}, 'Chat export', 'PASSWORD_HASH_SECRET')`;
 for (const id of [shared, foreign, cutoff, removed]) await sql`insert into chat_conversations (id, creator_id, created, metadata) values (${id}, ${peer}::bigint, true,
  '{"group_name":"Encrypted group title","description":"Encrypted description","created_at_msec":"1000","message_ttl_msec":"60000","classification":{"group_type":"Normal"},"admin_settings":{"send_message":false,"start_call":{"secret":"NESTED_SECRET"}},"invite_url":"INVITE_SECRET","realm_secret":"REALM_SECRET","pin":"PIN_SECRET"}'::jsonb)`;
 for (const conversation of [shared, cutoff, removed]) {
  await sql`insert into chat_members (conversation_id, user_id, accepted, archived, muted) values (${conversation}, ${owner}::bigint, false, true, true), (${conversation}, ${peer}::bigint, true, false, false)`;
 }
 await sql`insert into chat_members (conversation_id, user_id) values (${foreign}, ${peer}::bigint), (${foreign}, ${stranger}::bigint)`;
 await sql`insert into chat_keys (user_id, version, public_key, signing_public_key, identity_public_key_signature) values (${owner}::bigint, 1, 'PUBLIC_KEY_SECRET', 'SIGNING_KEY_SECRET', 'KEY_SIGNATURE_SECRET')`;
 const own = await event(shared, owner, 1, "OWN_CIPHERTEXT", { siblingKey: true });
 const incoming = await event(shared, peer, 1, "INCOMING_CIPHERTEXT", { audience: owner });
 const hiddenByPeer = await event(shared, peer, 1, "STILL_VISIBLE_CIPHERTEXT");
 await sql`insert into chat_hidden_events (user_id, seq) values (${peer}::bigint, ${hiddenByPeer}::bigint)`;
 const foreignAudience = await event(shared, peer, 1, "FOREIGN_AUDIENCE_SECRET", { audience: stranger });
 const deleted = await event(shared, peer, 1, "DELETED_SECRET", { deleted: true });
 const hidden = await event(shared, peer, 1, "HIDDEN_SECRET");
 await sql`insert into chat_hidden_events (user_id, seq) values (${owner}::bigint, ${hidden}::bigint)`;
 const before = await event(cutoff, peer, 1, "BEFORE_CUTOFF_SECRET");
 const at = await event(cutoff, peer, 1, "AT_CUTOFF_SECRET");
 await sql`update chat_members set deleted_before = ${at}::bigint where conversation_id = ${cutoff} and user_id = ${owner}::bigint`;
 const after = await event(cutoff, peer, 1, "AFTER_CUTOFF_CIPHERTEXT");
 const foreignEvent = await event(foreign, owner, 1, "NON_MEMBER_SECRET");
 const key = await event(shared, peer, 3, "WRAPPED_KEY_SECRET");
 const unknown = await event(shared, peer, 99, "UNKNOWN_KIND_SECRET");
 const invalid = await event(shared, peer, 1, "unused", { raw: Buffer.from("MALFORMED_SECRET") });
 const racedDelete = await event(shared, peer, 1, "RACED_DELETE_SECRET");
 const racedAudience = await event(shared, peer, 1, "RACED_AUDIENCE_SECRET");
 const racedBody = await event(shared, peer, 1, "OLD_BODY_SECRET");
 const racedMembership = await event(removed, peer, 1, "REMOVED_MEMBERSHIP_SECRET");
 const racedCutoff = await event(cutoff, peer, 1, "RACED_CUTOFF_SECRET");
 const cutoffVisible = await event(cutoff, peer, 1, "VISIBLE_AFTER_NEW_CUTOFF");
 await sql`insert into chat_uploads (hash, resume_id, conversation_id, message_id, uploader_id, total_bytes, ready) values ('FOREIGN_CHAT_UPLOAD_SECRET', ${newId()}::bigint, ${shared}, 'attachment', ${peer}::bigint, 4, true)`;
 for (const kind of [4, 7, 8, 12, 13]) await event(shared, peer, kind, `VISIBLE_KIND_${kind}`);
 // More than one row-count batch, then a >1MiB blob that must travel alone.
 for (let i = 0; i < 140; i++) await event(shared, peer, 12, `receipt_${i}`);
 const large = await event(shared, owner, 1, new Uint8Array(1048576 + 32).fill(65));
 await event(shared, peer, 12, "after_large_receipt");
 // A failed stage must roll back retention cleanup and leave no new archive.
 const expiredArchive = newId();
 await sql`insert into data_exports (id, user_id, body, created_at) values (${expiredArchive}::bigint, ${owner}::bigint, '{"old_archive":true}'::jsonb, now() - interval '8 days')`;
 (sql as any).begin = (callback: any) => nativeBegin((tx) => callback(new Proxy(tx, {
  async apply(target, thisArg, args) {
   const result = await Reflect.apply(target, thisArg, args);
   if (args[0]?.join?.(" ").includes("create temporary table data_export_chat_details")) throw new Error("intentional staging failure");
   return result;
  },
 })));
 await assert.rejects(() => exportRoute("POST"), /intentional staging failure/);
 assert.equal((await sql`select count(*)::int n from data_exports where user_id = ${owner}::bigint`)[0].n, 1);
 assert.equal((await sql`select body from data_exports where id = ${expiredArchive}::bigint`)[0].body.old_archive, true, "failed generation preserves previously stored archive");
 assert.equal((await sql`select to_regclass('pg_temp.data_export_chat_details') as name`)[0].name, null);
 let raced = false, stagedBatches = 0, observedBatches = 0;
 (sql as any).begin = (callback: any) => nativeBegin((tx) => callback(new Proxy(tx, {
  async apply(target, thisArg, args) {
   const result = await Reflect.apply(target, thisArg, args);
   const query = args[0]?.join?.(" ") ?? "";
   if (query.includes("with candidates as")) {
    observedBatches++;
    const bytes = result.reduce((sum: number, row: any) => sum + row.event.byteLength, 0);
    assert(bytes <= 1048576 || result.length === 1, "JS batches stay within byte budget unless processing one large event alone");
    assert(result.length <= 128);
   }
   if (query.includes("insert into pg_temp.data_export_chat_details")) {
    stagedBatches++;
    if (!raced) {
     raced = true;
     await control`update chat_events set deleted = true where seq = ${racedDelete}::bigint`;
     await control`update chat_events set audience_id = ${stranger}::bigint where seq = ${racedAudience}::bigint`;
     await control`update chat_events set event = ${encoded(1, "NEW_BODY_SECRET")} where seq = ${racedBody}::bigint`;
     await control`delete from chat_members where conversation_id = ${removed} and user_id = ${owner}::bigint`;
     await control`update chat_members set deleted_before = ${racedCutoff}::bigint where conversation_id = ${cutoff} and user_id = ${owner}::bigint`;
    }
   }
   return result;
  },
 })));
 assert.equal((await exportRoute("POST")).status, 200);
 (sql as any).begin = nativeBegin;
 assert(raced); assert(stagedBatches >= 4); assert(observedBatches > stagedBatches);
 const entries = await (await exportRoute("GET")).json();
 assert.equal(entries.length, 1);
 const response = await exportRoute("GET", `/xitter/export/${entries[0].id}`);
 assert.equal(response.headers.get("cache-control"), "no-store");
 const archive = await response.json(), chat = archive.chat;
 assert.equal(chat.format, "xitter-chat-event-details"); assert.equal(chat.version, 1); assert.equal(chat.includes_decryption_keys, false);
 const group = chat.conversations.find((c: any) => c.id === shared);
 assert.deepEqual(group.participant_ids, [owner, peer].sort());
 assert.equal(group.accepted, false); assert.equal(group.archived, true); assert.equal(group.muted, true);
 assert.equal(group.metadata.group_name, "Encrypted group title"); assert.equal(group.metadata.admin_settings.send_message, false); assert.equal(group.metadata.admin_settings.start_call, null);
 assert(!chat.conversations.some((c: any) => c.id === foreign || c.id === removed));
 const ids = new Set(chat.events.map((e: any) => e.seq));
 assert(ids.has(own)); assert(ids.has(incoming)); assert(ids.has(hiddenByPeer)); assert(ids.has(large)); assert(ids.has(cutoffVisible));
 for (const seq of [foreignAudience, deleted, hidden, before, at, after, foreignEvent, key, unknown, invalid, racedDelete, racedAudience, racedBody, racedMembership, racedCutoff]) assert(!ids.has(seq), `inaccessible/stale/key event omitted: ${seq}`);
 const bytes: string[] = [];
 for (const entry of chat.events) {
  const raw = Buffer.from(entry.event_detail_base64, "base64"); bytes.push(raw.toString("latin1"));
  const detail = thrift.decode(raw); assert.deepEqual(Object.keys(detail), [String(entry.kind)]);
  assert(!detail[3], "key-change union member is never included");
 }
 const ownDetail = thrift.decode(Buffer.from(chat.events.find((e: any) => e.seq === own).event_detail_base64, "base64"));
 assert.equal(thrift.text(thrift.fields(ownDetail[1])?.[100]), "OWN_CIPHERTEXT");
 const inspect = JSON.stringify(archive) + bytes.join(" ");
 for (const secret of ["OUTER_CONVERSATION_TOKEN", "WRAPPED_KEY_SECRET", "SIGNING_KEY_SENTINEL", "PUBLIC_KEY_SECRET", "SIGNING_KEY_SECRET", "KEY_SIGNATURE_SECRET", "PASSWORD_HASH_SECRET", "INVITE_SECRET", "REALM_SECRET", "PIN_SECRET", "NESTED_SECRET", "FOREIGN_AUDIENCE_SECRET", "DELETED_SECRET", "HIDDEN_SECRET", "NON_MEMBER_SECRET", "OLD_BODY_SECRET", "NEW_BODY_SECRET", "REMOVED_MEMBERSHIP_SECRET", "RACED_CUTOFF_SECRET", "FOREIGN_CHAT_UPLOAD_SECRET"]) assert(!inspect.includes(secret), `no unauthorized data/key/token material: ${secret}`);
 assert.equal((await sql`select to_regclass('pg_temp.data_export_chat_details') as name`)[0].name, null);
 await Promise.all(Array.from({ length: 8 }, () => exportRoute("POST")));
 assert.equal((await sql`select count(*)::int n from data_exports where user_id = ${owner}::bigint`)[0].n, 1);
 console.log("Chat archive passed: encrypted detail content, five visibility guards and staging races, token/key exclusion, bounded batches, atomic rollback, daily quota");
} finally {
 (sql as any).begin = nativeBegin;
 await control.close();
 await sql`delete from users where id in (${owner}::bigint, ${peer}::bigint, ${stranger}::bigint)`;
 await sql.close();
}
