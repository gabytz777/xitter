// Query-operator regression checks against a migrated, dedicated Postgres database.
// DATABASE_URL=postgres://localhost/xitter_test bun scripts/test-search-operators.ts
import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { createUser } from "../src/auth";
import { sql } from "../src/db";
import { newId } from "../src/ids";
import { hashtagsLike, postCondition } from "../src/search";

const name = `s${randomBytes(6).toString("hex")}`;
const user = await createUser(name, "Search operator test", "testpass123");
const original = newId(), quoted = newId();
try {
	await sql`insert into posts (id, user_id, text, conversation_id, created_at) values
		(${original}::bigint, ${user}::bigint, 'needle ordinary post #привет #你好 #café #go #δοκιμή', ${original}::bigint, '2024-02-29T12:00:00Z'),
		(${quoted}::bigint, ${user}::bigint, 'needle quote post #приветик #你好世界 #caféine #gold #δοκιμήμετά', ${quoted}::bigint, '2024-03-01T12:00:00Z')`;
	await sql`update posts set quote_id = ${original}::bigint where id = ${quoted}::bigint`;
	const matches = async (query: string) => {
		const cond = postCondition(query, user);
		assert(cond, `condition for ${query}`);
		return (await sql`select p.id::text from posts p where p.user_id = ${user}::bigint and ${cond} order by p.id`).map((r) => r.id);
	};
	for (const tag of ["привет", "你好", "café", "go", "δοκιμή"]) {
		assert.deepEqual(await matches(`#${tag}`), [original]);
		assert.deepEqual(await matches(`needle -#${tag}`), [quoted]);
		assert((await hashtagsLike(`#${tag}`, 20)).includes(`#${tag}`));
	}
	assert.deepEqual(await matches(`needle -from:missing_handle`), [original, quoted].sort());
	assert.deepEqual(await matches(`needle from:${name}`), [original, quoted].sort());
	assert.deepEqual(await matches(`needle -from:${name} OR from:missing_handle`), []);
	assert.deepEqual(await matches(`needle -from:${name}`), []);
	assert.deepEqual(await matches(`needle -quoted_tweet_id:${original}`), [original]);
	assert.deepEqual(await matches(`needle quoted_tweet_id:${original}`), [quoted]);
	assert.deepEqual(await matches("needle quoted_tweet_id:9999999999999999999"), []);
	assert.deepEqual(await matches("needle -quoted_tweet_id:9999999999999999999"), [original, quoted].sort());
	assert.deepEqual(await matches("needle since:2024-02-29 until:2024-03-01"), [original]);
	for (const date of ["2024-02-30", "2023-02-29", "2024-13-01", "2024-00-01", "2024-01-00", "0000-01-01", "1900-02-29"]) {
		assert.deepEqual(await matches(`needle since:${date}`), []);
		assert.deepEqual(await matches(`needle until:${date}`), []);
	}
	assert.deepEqual(await matches("needle since:2000-02-29"), [original, quoted].sort());
	console.log("ok: negative author and quote filters keep unrelated posts; Unicode hashtag searches and suggestions work; date filters handle leap years and reject impossible dates without database errors");
} finally {
	await sql`delete from users where id = ${user}::bigint`;
	await sql.close();
}
