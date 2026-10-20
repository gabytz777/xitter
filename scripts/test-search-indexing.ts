// Run against a migrated disposable PostgreSQL database.
import { strict as assert } from "node:assert";
import { sql } from "../src/db";

const database = new URL(process.env.DATABASE_URL ?? "postgres://localhost/xitter");
assert(["localhost", "127.0.0.1"].includes(database.hostname) && /test|codex/.test(database.pathname), "Use a disposable local test database.");

try {
	const indexes = await sql`select tablename, indexname, indexdef from pg_indexes where schemaname = current_schema()
		and indexname in ('posts_text_trgm_idx', 'users_handle_trgm_idx', 'users_name_trgm_idx', 'users_bio_trgm_idx')`;
	assert.equal(indexes.length, 4, "all text search indexes are present");
	for (const index of indexes) assert.match(index.indexdef, /USING gin .*gin_trgm_ops/i);
	const [{ extversion }] = await sql`select extversion from pg_extension where extname = 'pg_trgm'`;
	assert(extversion, "pg_trgm is enabled");
	console.log("search trigram indexes are installed");
} finally {
	await sql.close();
}
