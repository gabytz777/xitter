// Real PostgreSQL regression for profile following/followers pagination.
// DATABASE_URL must be a migrated test DB.
import assert from "node:assert/strict";
import type { Viewer } from "../src/auth";
import { callOperation } from "../src/graphql";
import { sql } from "../src/db";
import { newId } from "../src/ids";

const tag = `fp${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
const viewerId = newId();
const followees = Array.from({ length: 201 }, () => newId());
const viewer = { id: viewerId } as Viewer;
const entries = (result: any) => result.data.user.result.timeline.timeline.instructions[0]?.entries ?? [];
const userIds = (items: any[]) => items.filter((e: any) => e.entryId.startsWith("user-")).map((e: any) => e.content.itemContent.user_results.result.rest_id);
const cursor = (items: any[]) => items.find((e: any) => e.content.cursorType === "Bottom")?.content.value;

try {
	for (const [i, id] of [viewerId, ...followees].entries()) {
		await sql`insert into users (id, screen_name, name, password_hash) values (${id}::bigint, ${`${tag}${i}`}, 'Follow pagination fixture', '!')`;
	}
	for (const id of followees) {
		await sql`insert into follows (follower_id, followee_id, created_at) values (${viewerId}::bigint, ${id}::bigint, '2026-01-01 00:00:00+00')`;
	}

	const first = entries(await callOperation("Following", viewer, { userId: viewerId }));
	assert.equal(userIds(first).length, 200);
	const next = cursor(first);
	assert(next);
	const second = entries(await callOperation("Following", viewer, { userId: viewerId, cursor: next }));
	assert.equal(userIds(second).length, 1);
	assert.equal(cursor(second), undefined);
	assert.deepEqual(new Set([...userIds(first), ...userIds(second)]), new Set(followees));

	const malformed = entries(await callOperation("Following", viewer, { userId: viewerId, cursor: "junk" }));
	assert.equal(userIds(malformed).length, 0);
	console.log("Profile follow pagination passed: 201 follows across two pages, stable end cursor, malformed cursor ignored");
} finally {
	await sql`delete from users where screen_name like ${`${tag}%`}`;
	await sql.close();
}
