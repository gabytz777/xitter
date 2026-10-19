// Real PostgreSQL + HTTP media privacy checks; isolated files, no external calls.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const database = new URL(process.env.DATABASE_URL ?? "postgres://localhost/xitter");
assert(["localhost", "127.0.0.1"].includes(database.hostname) && /test|codex/.test(database.pathname), "Use a disposable local test database.");
const dir = mkdtempSync(join(tmpdir(), "xitter-media-privacy-"));
process.env.MEDIA_DIR = dir;
const { sql } = await import("../src/db");
const { newId } = await import("../src/ids");
const { serveMedia } = await import("../src/media");
const { createCard, attachPoll, IMAGE_POLL, PollError, pollsByIds } = await import("../src/polls");
const owner = newId(), follower = newId(), stranger = newId(), staff = newId();
const { asRequest, markStaff } = await import("../src/staff-access");
let triggerName: string | undefined;
const media = newId(), regular = newId(), post = newId(), ordinaryPost = newId();
const viewer = (id: string) => ({ id, screen_name: `media_${id}` }) as any;
const server = Bun.serve({ port: 0, fetch(req) { return asRequest(() => { if (req.headers.get("x-staff") === "1") markStaff(); return serveMedia(req, new URL(req.url).pathname, viewer(req.headers.get("x-viewer") ?? stranger)); }); } });
const get = (id: string, who = stranger, range?: string, gatedStaff = false) => fetch(`http://localhost:${server.port}/media/${id}.png`, { headers: { "x-viewer": who, ...(gatedStaff ? { "x-staff": "1" } : {}), ...(range ? { range } : {}) } });
try {
 for (const id of [owner, follower, stranger, staff]) await sql`insert into users (id, screen_name, name, password_hash) values (${id}::bigint, ${`media_${id}`}, 'Media Test', 'unusable')`;
 for (const id of [media, regular]) {
  await sql`insert into media (id, user_id, kind, mime, size, width, height) values (${id}::bigint, ${owner}::bigint, 'photo', 'image/png', 4, 1, 1)`;
  writeFileSync(join(dir, id), "data");
 }
 await sql`update users set role = 'admin' where id = ${staff}::bigint`;
 await sql`update users set protected = true where id = ${owner}::bigint`;
 await sql`insert into follows (follower_id, followee_id) values (${follower}::bigint, ${owner}::bigint)`;
 const card = await createCard(owner, JSON.stringify({ "twitter:card": IMAGE_POLL, "twitter:string:choice1_label": "Private image", "twitter:string:choice2_label": "Other", "twitter:image:choice1_image:src:id": `mis://${media}` }));
 assert.equal((await get(media)).status, 404, "unpublished image poll choices remain private");
 assert.equal((await get(media, owner)).status, 200);
 for (const id of [post, ordinaryPost]) await sql`insert into posts (id, user_id, text, conversation_id) values (${id}::bigint, ${owner}::bigint, 'photo', ${id}::bigint)`;
 await attachPoll(owner, post, card.card_uri);
 await sql`update media set post_id = ${ordinaryPost}::bigint where id = ${regular}::bigint`;
 assert.equal((await get(media)).status, 404, "private poll choice image cannot be fetched by stranger");
 for (const id of [media, regular]) {
  assert.equal((await get(id, owner)).status, 200);
  const allowed = await get(id, follower, "bytes=0-1");
  assert.equal(allowed.status, 206); assert.equal(await allowed.text(), "da");
  assert.match(allowed.headers.get("cache-control")!, /private.*no-store/, "private bytes must never enter shared or persistent cache");
 }
 await sql`update users set protected = false where id = ${owner}::bigint`;
 for (const id of [media, regular]) assert.equal((await get(id)).status, 200);
 // A request immediately before privacy changes must not warm an authorization cache.
 await sql`update users set protected = true where id = ${owner}::bigint`;
 for (const id of [media, regular]) assert.equal((await get(id)).status, 404, "privacy change takes effect immediately");
 await sql`update users set protected = false where id = ${owner}::bigint`;
 await sql`insert into blocks (blocker_id, blocked_id) values (${owner}::bigint, ${stranger}::bigint)`;
 for (const id of [media, regular]) assert.equal((await get(id)).status, 404, "blocks apply to media bytes");
 await sql`delete from blocks where blocker_id = ${owner}::bigint`;
 await sql`update posts set hidden = true where id in (${post}::bigint, ${ordinaryPost}::bigint)`;
 for (const id of [media, regular]) {
  assert.equal((await get(id)).status, 404, "hidden post media stays hidden");
  assert.equal((await get(id, staff)).status, 404, "staff role alone does not bypass media visibility");
  assert.equal((await get(id, staff, undefined, true)).status, 200, "authorized staff review can access hidden media");
 }
 await sql`update posts set hidden = false where id in (${post}::bigint, ${ordinaryPost}::bigint)`;
 await sql`update users set status = 'suspended' where id = ${owner}::bigint`;
 for (const id of [media, regular]) assert.equal((await get(id)).status, 404, "suspended account media stays hidden");
 await sql`update users set status = 'active' where id = ${owner}::bigint`;
 await sql`delete from posts where id in (${post}::bigint, ${ordinaryPost}::bigint)`;
 for (const id of [media, regular]) assert.equal((await get(id)).status, 404, "deleted post media stays private");
 // Failed attachment must neither steal a post nor spend the poll.
 for (const raw of ["null", "[]", "5"]) await assert.rejects(() => createCard(owner, raw), PollError);
 const textCard = await createCard(owner, JSON.stringify({ "twitter:card": "poll2choice_text_only", "twitter:string:choice1_label": "A", "twitter:string:choice2_label": "B" }));
 const foreignPost = newId();
 await sql`insert into posts (id, user_id, text, conversation_id) values (${foreignPost}::bigint, ${stranger}::bigint, 'foreign', ${foreignPost}::bigint)`;
 await assert.rejects(() => attachPoll(owner, foreignPost, textCard.card_uri), PollError);
 assert.equal((await sql`select ends_at from polls where id = ${textCard.card_uri.slice(7)}::bigint`)[0].ends_at, null);
 const ownPost = newId();
 await sql`insert into posts (id, user_id, text, conversation_id) values (${ownPost}::bigint, ${owner}::bigint, 'own', ${ownPost}::bigint)`;
 triggerName = `test_poll_attach_${owner}`;
 await sql.unsafe(`create function ${triggerName}() returns trigger language plpgsql as $$ begin if NEW.id = ${ownPost} and NEW.poll_id is not null then raise exception 'intentional attachment failure'; end if; return NEW; end $$`);
 await sql.unsafe(`create trigger ${triggerName} before update of poll_id on posts for each row execute function ${triggerName}()`);
 await assert.rejects(() => attachPoll(owner, ownPost, textCard.card_uri), /intentional attachment failure/);
 assert.equal((await sql`select ends_at from polls where id = ${textCard.card_uri.slice(7)}::bigint`)[0].ends_at, null, "failed post update rolls back poll clock");
 await sql.unsafe(`drop trigger ${triggerName} on posts`); await sql.unsafe(`drop function ${triggerName}()`); triggerName = undefined;
 await attachPoll(owner, ownPost, textCard.card_uri);
 assert.equal((await pollsByIds(stranger, [textCard.card_uri.slice(7)])).size, 1);
 assert.equal((await get("9999999999999999999")).status, 404, "bigint overflow cannot reach DB/federation lookup");
 await assert.rejects(() => attachPoll(owner, ownPost, "card://9999999999999999999"), PollError);
 assert.equal((await pollsByIds(stranger, ["9999999999999999999"])).size, 0);
 console.log("Poll/media HTTP privacy, immediate revocation, ranges, attachment ownership and bigint checks passed");
} finally {
 await server.stop(true);
 if (triggerName) { await sql.unsafe(`drop trigger if exists ${triggerName} on posts`); await sql.unsafe(`drop function if exists ${triggerName}()`); }
 await sql`delete from users where id in (${owner}::bigint, ${follower}::bigint, ${stranger}::bigint, ${staff}::bigint)`;
 await sql.close(); rmSync(dir, { recursive: true, force: true });
}
