// Direct route integration checks using a migrated, disposable PostgreSQL database.
// DATABASE_URL=postgres://localhost/xitter_test bun scripts/test-data-export.ts
import { strict as assert } from "node:assert";
import { sql } from "../src/db";
import { newId } from "../src/ids";
import type { Viewer } from "../src/auth";
import { dataExportRoute } from "../src/data-export";

const database = new URL(process.env.DATABASE_URL ?? "postgres://localhost/xitter");
assert(["localhost", "127.0.0.1"].includes(database.hostname) && /test|codex/.test(database.pathname), "Use a disposable local test database.");

const owner = newId(), other = newId();
const viewer = { id: owner, screen_name: `export_${owner}` } as Viewer;
const route = async (method: string, path = "/1.1/account/user_twitter_data", user = viewer) => {
 const response = await dataExportRoute(method, path, user, new Request("http://localhost/"));
 assert(response); return response;
};
try {
 for (const id of [owner, other]) await sql`insert into users (id, screen_name, name, password_hash) values (${id}::bigint, ${`export_${id}`}, 'Export Test', 'not-a-secret')`;
 for (const id of [owner, other]) {
  await sql`insert into scheduled_posts (id, user_id, kind, request) values (${newId()}::bigint, ${id}::bigint, 'draft', ${JSON.stringify({ status: `private draft ${id}` })}::text::jsonb)`;
  await sql`insert into scheduled_posts (id, user_id, kind, execute_at, request) values (${newId()}::bigint, ${id}::bigint, 'scheduled', now() + interval '1 hour', ${JSON.stringify({ status: `future post ${id}` })}::text::jsonb)`;
 }
 await Promise.all(Array.from({ length: 12 }, () => route("POST")));
 const exports = await (await route("GET")).json();
 const [count] = await sql`select count(*)::int as n from data_exports where user_id = ${owner}::bigint`;
 assert.equal(count.n, 1, "concurrent requests create only one daily archive");
 const response = await route("GET", `/xitter/export/${exports[0].id}`);
 assert.equal(response.headers.get("cache-control"), "no-store");
 const archive = await response.json();
 assert(Array.isArray(archive.posts) && Array.isArray(archive.followers), "existing archive keys remain");
 assert.equal(archive.drafts.length, 1, "includes only own draft");
 assert.equal(archive.scheduled_posts.length, 1, "includes only own scheduled post");
 assert.equal(archive.drafts[0].request.status, `private draft ${owner}`);
 assert.equal(archive.scheduled_posts[0].request.status, `future post ${owner}`);
 assert.match(archive.scheduled_posts[0].execute_at, /Z$/);
 assert(!JSON.stringify(archive).includes(other), "other account private drafts stay private");
 assert(!JSON.stringify(archive).includes("not-a-secret"), "password hashes are never exported");
 assert.equal((await route("GET", `/xitter/export/${exports[0].id}`, { ...viewer, id: other })).status, 404);
 await route("POST");
 assert.equal((await (await route("GET")).json()).length, 1, "repeated requests reuse archive");
 await sql`update data_exports set created_at = now() - interval '8 days' where user_id = ${owner}::bigint`;
 await route("POST");
 const fresh = await (await route("GET")).json();
 assert.equal(fresh.length, 1, "expired archive removed");
 assert.notEqual(fresh[0].id, exports[0].id, "new archive created after expiry");
 console.log("data export concurrency, completeness, isolation and retention checks passed");
} finally {
 await sql`delete from users where id in (${owner}::bigint, ${other}::bigint)`;
 await sql.close();
}
