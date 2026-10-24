// Real PostgreSQL regression for suggested list members pagination.
// DATABASE_URL must be a migrated test DB.
import assert from "node:assert/strict";
import type { Viewer } from "../src/auth";
import { listHandlers } from "../src/lists";
import { sql } from "../src/db";
import { newId } from "../src/ids";

const tag = `lr${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
const user = newId(), list = newId();
const followees = Array.from({ length: 21 }, () => newId());
const viewer = { id: user } as Viewer;
const entries = (result: any) => result.data.list.recommended_users.timeline.instructions[0]?.entries ?? [];
const userIds = (items: any[]) => items.filter((e: any) => e.entryId.startsWith("user-")).map((e: any) => e.content.itemContent.user_results.result.rest_id);
const cursor = (items: any[]) => items.find((e: any) => e.content.cursorType === "Bottom")?.content.value;

try {
	for (const [i, id] of [user, ...followees].entries()) {
		await sql`insert into users (id, screen_name, name, password_hash) values (${id}::bigint, ${`${tag}${i}`}, 'List recommended fixture', '!')`;
	}
	await sql`insert into lists (id, owner_id, name) values (${list}::bigint, ${user}::bigint, 'Recommended pagination')`;
	for (const id of followees) {
		await sql`insert into follows (follower_id, followee_id) values (${user}::bigint, ${id}::bigint)`;
	}

	const first = entries(await listHandlers.ListEditRecommendedUsers(viewer, { listId: list }));
	assert.equal(userIds(first).length, 20);
	const next = cursor(first);
	assert(next);
	const second = entries(await listHandlers.ListEditRecommendedUsers(viewer, { listId: list, cursor: next }));
	assert.equal(userIds(second).length, 1);
	assert.equal(cursor(second), undefined);
	assert.deepEqual(new Set([...userIds(first), ...userIds(second)]), new Set(followees));

	const malformed = entries(await listHandlers.ListEditRecommendedUsers(viewer, { listId: list, cursor: "junk" }));
	assert.equal(userIds(malformed).length, 0);
	console.log("List recommended pagination passed: 21 suggestions across two pages, stable end cursor, malformed cursor ignored");
} finally {
	await sql`delete from users where screen_name like ${`${tag}%`}`;
	await sql.close();
}
