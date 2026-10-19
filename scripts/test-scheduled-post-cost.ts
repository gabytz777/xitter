// Real PostgreSQL + HTTP checks of request middleware and GraphQL handlers.
// Limits deliberately enabled even when the integration job sets them off.
import assert from "node:assert/strict";
delete process.env.RATE_LIMITS;
const database = new URL(process.env.DATABASE_URL ?? "postgres://localhost/xitter");
assert(["localhost", "127.0.0.1"].includes(database.hostname) && /test|codex/.test(database.pathname), "Use a disposable local test database.");
const { sql } = await import("../src/db");
const { newId } = await import("../src/ids");
const { limitApi, chargePostCost, hit, limitOf } = await import("../src/ratelimit");
const { runOperation } = await import("../src/graphql");
const fixtures: string[] = [];
const viewers = new Map<string, any>();
async function fixture(role?: "admin") {
	const id = newId(); fixtures.push(id);
	await sql`insert into users(id,screen_name,name,password_hash,role) values(${id}::bigint,${`cost_${id}`},'Post cost regression','!',${role ?? null})`;
	const v = { id, role }; viewers.set(id, v); return v;
}
const server = Bun.serve({ port: 0, async fetch(req) {
	const v = viewers.get(req.headers.get("x-fixture") ?? "");
	if (!v) return new Response(null, { status: 401 });
	const url = new URL(req.url), op = url.pathname.slice(1);
	const limited = limitApi(v, "POST", `/graphql/${op}`, op, url);
	if (limited) return limited;
	return runOperation(op, v, await req.json());
} });
const request = (count: number) => ({ execute_at: Math.floor(Date.now() / 1000) + 3600,
	post_tweet_request: { status: "root", thread_tweets: Array.from({ length: count - 1 }, (_, i) => ({ status: `reply ${i}` })) } });
const call = (v: any, operation: string, vars: object) => fetch(`http://localhost:${server.port}/${operation}`, { method: "POST", headers: { "x-fixture": v.id, "content-type": "application/json" }, body: JSON.stringify(vars) });
const create = async (v: any, count = 1) => {
	const res = await call(v, "CreateScheduledTweet", request(count)); assert.equal(res.status, 200);
	const out = await res.json(); assert(out.data?.tweet?.rest_id, JSON.stringify(out)); return out.data.tweet.rest_id as string;
};
const limit = limitOf("post");
try {
	const v = await fixture();
	await create(v, 3);
	assert.equal(hit("post", v.id).remaining, limit - 4, "creation costs root middleware token plus both replies");
	const beforeInvalid = hit("post", v.id).remaining;
	const invalid = request(3); invalid.post_tweet_request.thread_tweets[1].status = "";
	const invalidResponse = await call(v, "CreateScheduledTweet", invalid);
	assert.equal((await invalidResponse.json()).errors[0].code, 170);
	assert.equal(hit("post", v.id).remaining, beforeInvalid - 2, "invalid request charges only existing middleware root, never extra parts");
	const limited = await fixture();
	chargePostCost(limited, limit - 2);
	const denied = await call(limited, "CreateScheduledTweet", request(3));
	assert.equal(denied.status, 429);
	assert.equal((await denied.json()).errors[0].code, 88);
	assert(Number(denied.headers.get("retry-after")) > 0);
	assert.equal(Number(denied.headers.get("x-rate-limit-remaining")), 1);
	assert.equal((await sql`select 1 from scheduled_posts where user_id=${limited.id}::bigint`).length, 0);
	assert.equal(hit("post", limited.id).remaining, 0, "weighted rejection spent no partial extra tokens");
	const edit = await fixture();
	const id = await create(edit);
	chargePostCost(edit, limit - 3); // Exactly two tokens remain for edit growth.
	const invalidEdit = request(4); invalidEdit.post_tweet_request.thread_tweets[2].status = "";
	const badEdit = await call(edit, "EditScheduledTweet", { ...invalidEdit, scheduled_tweet_id: id });
	assert.equal((await badEdit.json()).errors[0].code, 170, "failed edit validation must not charge growth tokens");
	const edits = await Promise.all(Array.from({ length: 8 }, () => call(edit, "EditScheduledTweet", { ...request(3), scheduled_tweet_id: id })));
	assert(edits.every((r) => r.status === 200), "same target growth must be charged once under the advisory lock");
	for (const response of edits) assert(!(await response.json()).errors);
	assert.equal(hit("post", edit.id).ok, false, "one +2 expansion consumes exactly the two remaining tokens");
	const grow = await call(edit, "EditScheduledTweet", { ...request(4), scheduled_tweet_id: id });
	assert.equal(grow.status, 429);
	assert.equal((await grow.json()).errors[0].code, 88);
	assert(Number(grow.headers.get("retry-after")) > 0);
	assert.equal(grow.headers.get("x-rate-limit-remaining"), "0");
	assert.equal((await sql`select jsonb_array_length(request->'thread_tweets') as n from scheduled_posts where id=${id}::bigint`)[0].n, 2, "rate-limited expansion preserves the stored thread");
	assert.equal((await call(edit, "EditScheduledTweet", { ...request(3), scheduled_tweet_id: id })).status, 200);
	assert.equal((await call(edit, "EditScheduledTweet", { ...request(1), scheduled_tweet_id: id })).status, 200, "shrinking is allowed at an exhausted post budget");
	assert.equal((await sql`select jsonb_array_length(request->'thread_tweets') as n from scheduled_posts where id=${id}::bigint`)[0].n, 0);
	const draft = await fixture();
	const draftResponse = await call(draft, "CreateDraftTweet", request(26));
	assert.equal(draftResponse.status, 200);
	assert(!(await draftResponse.json()).errors);
	assert.equal(hit("post", draft.id).remaining, limit - 2, "draft consumes only the pre-existing middleware token");
	const staff = await fixture("admin");
	chargePostCost(staff, limit * 2);
	await create(staff, 26);
	assert.equal(hit("post", staff.id).remaining, limit - 1, "staff bypass middleware and weighted budgets");
	console.log("Scheduled HTTP post costs passed: full creation cost, validation/rejection atomicity, concurrent edit delta, no-op/shrink, draft and staff exemptions, 429 metadata");
} finally {
	server.stop(true);
	for (const id of fixtures) await sql`delete from users where id=${id}::bigint`;
	await sql.close();
}
