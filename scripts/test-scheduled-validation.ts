// Real PostgreSQL regression coverage. Run with DATABASE_URL pointing at a migrated test database.
import assert from "node:assert/strict";
import type { Viewer } from "../src/auth";
import { sql } from "../src/db";
import { newId } from "../src/ids";
import { PostError } from "../src/posts";
import { scheduledHandlers as h } from "../src/scheduled";

const id = newId();
const otherId = newId();
const v = { id } as Viewer;
const at = Math.floor(Date.now() / 1000) + 3600;
const request = (status: string) => ({ post_tweet_request: { status }, execute_at: at });
let checks = 0;
async function rejects(fn: () => Promise<unknown>, code: number) {
	await assert.rejects(fn, (e: unknown) => e instanceof PostError && e.code === code);
	checks++;
}
try {
	await sql`insert into users (id, screen_name, name, password_hash) values (${id}::bigint, ${`sched_${id}`}, 'Scheduler test', '!'), (${otherId}::bigint, ${`sched_${otherId}`}, 'Other test', '!')`;
	const scheduled = (await h.CreateScheduledTweet(v, request("keep me"))).data.tweet.rest_id;
	const edit = (status: string) => h.EditScheduledTweet(v, { ...request(status), scheduled_tweet_id: scheduled });
	await rejects(() => edit("   "), 170);
	assert.equal((await sql`select request->>'status' as status from scheduled_posts where id = ${scheduled}::bigint`)[0].status, "keep me"); checks++;
	await rejects(() => h.CreateScheduledTweet(v, { ...request("bad date"), execute_at: 1e300 }), 214);
	await rejects(() => h.EditScheduledTweet(v, { ...request("bad date"), execute_at: -1e300, scheduled_tweet_id: scheduled }), 214);
	await rejects(() => h.EditScheduledTweet({ id: otherId } as Viewer, { ...request("foreign edit"), scheduled_tweet_id: scheduled }), 144);
	await sql`update users set status = 'suspended' where id = ${id}::bigint`;
	await rejects(() => edit("blocked edit"), 326);
	await sql`update users set status = 'active' where id = ${id}::bigint`;
	await rejects(() => edit("kill all trans people"), 186);
	assert.equal((await sql`select request->>'status' as status from scheduled_posts where id = ${scheduled}::bigint`)[0].status, "keep me"); checks++;
	// Reaching the creation quota must not prevent fixing an existing item.
	await sql`insert into scheduled_posts (id, user_id, kind, execute_at, request)
		select ${scheduled}::bigint + n, ${id}::bigint, 'scheduled', ${new Date(at * 1000)}, '{"status":"pending","media_ids":[]}'::jsonb from generate_series(1,99) n`;
	await edit("fixed at quota"); checks++;
	await rejects(() => h.CreateScheduledTweet(v, request("over quota")), 214);
	const draft = (await h.CreateDraftTweet(v, request("draft"))).data.tweet.rest_id;
	await h.EditDraftTweet(v, { draft_tweet_id: draft, ...request("") }); checks++;
	await sql`insert into scheduled_posts (id, user_id, kind, request)
		select ${draft}::bigint + n, ${id}::bigint, 'draft', '{"status":"pending","media_ids":[]}'::jsonb from generate_series(1,99) n`;
	await h.EditDraftTweet(v, { draft_tweet_id: draft, ...request("fixed draft at quota") }); checks++;
	await rejects(() => h.CreateDraftTweet(v, request("over draft quota")), 214);
	await rejects(() => h.EditScheduledTweet(v, { scheduled_tweet_id: scheduled, execute_at: at, post_tweet_request: { status: { invalid: true }, media_ids: {} } }), 170);
	await rejects(() => h.EditScheduledTweet(v, { scheduled_tweet_id: scheduled, execute_at: "invalid", post_tweet_request: { status: "valid" } }), 214);
	await rejects(() => h.EditDraftTweet(v, { draft_tweet_id: draft, ...request("kill all trans people") }), 186);
	console.log(`${checks} scheduled validation checks passed`);
} finally {
	await sql`delete from users where id in (${id}::bigint, ${otherId}::bigint)`;
	await sql.close();
}
