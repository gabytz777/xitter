// Subprocess regression: pool=1 must publish without waiting on its own reserved
// connection. Snapshot races are injected immediately before the queue claim.
import assert from "node:assert/strict";
const database = new URL(process.env.DATABASE_URL ?? "postgres://localhost/xitter");
assert(["localhost", "127.0.0.1"].includes(database.hostname) && /test|codex/.test(database.pathname), "Use a disposable local test database.");
const { sql } = await import("../src/db");
if (process.argv[2] === "--worker") {
 const { runDue } = await import("../src/scheduled");
 const [mode, id] = process.argv.slice(3);
 const begin = sql.begin.bind(sql);
 let intercepted = false;
 if (mode !== "normal") (sql as any).begin = async (...args: any[]) => {
  if (!intercepted) {
   intercepted = true;
   const status = mode === "stale-approval" ? "kill all trans people" : "fresh benign edit";
   await sql`update scheduled_posts set request = ${JSON.stringify({ status, thread_tweets: [], media_ids: [] })}::text::jsonb where id = ${id}::bigint`;
  }
  return (begin as any)(...args);
 };
 try { console.log(`worker handled ${await runDue()}`); } finally { await sql.close(); }
} else {
 const { newId } = await import("../src/ids");
 const owner = newId(), other = newId(), parent = newId(), quote = newId();
 const ownerName = `single${owner.slice(-8)}`, otherName = `peer${other.slice(-8)}`;
 const child = async (mode = "normal", id = "") => {
  const process_ = Bun.spawn([process.execPath, import.meta.path, "--worker", mode, id], { env: { ...process.env, DB_POOL_MAX: "1", RATE_LIMITS: "off" }, stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; process_.kill(); }, 5000);
  const output = new Response(process_.stdout).text(), errors = new Response(process_.stderr).text();
  const exit = await process_.exited; clearTimeout(timer);
  const [out, err] = await Promise.all([output, errors]);
  assert(!timedOut, `single-connection worker timed out: ${out}\n${err}`);
  assert.equal(exit, 0, `${out}\n${err}`);
 };
 const schedule = async (request: object) => {
  const id = newId(); await sql`insert into scheduled_posts (id, user_id, kind, execute_at, request) values (${id}::bigint, ${owner}::bigint, 'scheduled', now() - interval '1 minute', ${JSON.stringify(request)}::text::jsonb)`; return id;
 };
 try {
  for (const [id, name] of [[owner, ownerName], [other, otherName]]) await sql`insert into users (id, screen_name, name, password_hash) values (${id}::bigint, ${name}, 'Single connection', 'unusable')`;
  for (const id of [parent, quote]) await sql`insert into posts (id, user_id, text, conversation_id) values (${id}::bigint, ${other}::bigint, 'existing parent or quote', ${id}::bigint)`;
  await schedule({ status: `single root @${otherName}`, in_reply_to_status_id: parent, media_ids: [], thread_tweets: [{ status: "single quote reply", attachment_url: `https://example.test/u/status/${quote}` }] });
  await child();
  const posts = await sql`select id::text, text, reply_to_id::text, conversation_id::text, quote_id::text from posts where user_id = ${owner}::bigint order by id`;
  assert.equal(posts.length, 2); assert.equal(posts[0].reply_to_id, parent); assert.equal(posts[1].reply_to_id, posts[0].id); assert.equal(posts[1].quote_id, quote);
  assert.equal((await sql`select count(*)::int n from post_mentions where post_id = ${posts[0].id}::bigint and user_id = ${other}::bigint`)[0].n, 1);
  console.log("ok: pool=1 publishes full thread with parent/root/quote/block checks and uncommitted mention writes");
  const approval = await schedule({ status: "original benign text", media_ids: [], thread_tweets: [] });
  await child("stale-approval", approval);
  assert.equal((await sql`select kind from scheduled_posts where id = ${approval}::bigint`)[0].kind, "scheduled", "edited request must skip stale approval");
  assert.equal((await sql`select count(*)::int n from posts where user_id = ${owner}::bigint`)[0].n, 2);
  await child();
  assert.equal((await sql`select kind from scheduled_posts where id = ${approval}::bigint`)[0].kind, "draft");
  assert((await sql`select 1 from audit_log where target = ${owner} and action in ('automod_strike', 'automod_second_chance')`).length > 0, "refusal safety action commits outside publication");
  const refusal = await schedule({ status: "kill all trans people", media_ids: [], thread_tweets: [] });
  await child("stale-refusal", refusal);
  assert.equal((await sql`select kind from scheduled_posts where id = ${refusal}::bigint`)[0].kind, "scheduled", "stale refusal cannot rescue an edited request as a draft");
  await child();
  assert.equal((await sql`select count(*)::int n from posts where user_id = ${owner}::bigint and text = 'fresh benign edit'`)[0].n, 1);
  console.log("ok: snapshot guards reject stale approval and refusal; next passes recheck content and preserve moderation actions");
 } finally {
  await sql`delete from audit_log where target in (${owner}, ${other})`;
  await sql`delete from users where id in (${owner}::bigint, ${other}::bigint)`;
  await sql.close();
 }
}
