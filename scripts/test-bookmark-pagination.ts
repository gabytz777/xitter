// Real PostgreSQL pagination/visibility regression. DATABASE_URL must be a migrated test DB.
import assert from "node:assert/strict";
import type { Viewer } from "../src/auth";
import { bookmarkFolderHandlers as h } from "../src/bookmark-folders";
import { sql } from "../src/db";
import { newId } from "../src/ids";
import { PostError, folderPosts } from "../src/posts";

const user = newId(), author = newId(), foreign = newId(), folder = newId();
const v = { id: user } as Viewer;
const entries = (result: any) => result.data.bookmark_collection_timeline.timeline.instructions[0].entries;
const postIds = (items: any[]) => items.filter((e: any) => e.entryId.startsWith("tweet-")).map((e: any) => e.content.itemContent.tweet_results.result.rest_id);
const cursor = (items: any[]) => items.find((e: any) => e.content.cursorType === "Bottom")?.content.value;
try {
	for (const id of [user, author, foreign]) await sql`insert into users (id, screen_name, name, password_hash) values (${id}::bigint, ${`page_${id}`}, 'Pagination fixture', '!')`;
	await sql`insert into bookmark_folders (id,user_id,name) values (${folder}::bigint,${user}::bigint,'Pagination')`;
	const base = BigInt(newId());
	const ids = Array.from({ length: 205 }, (_, i) => String(base + BigInt(i)));
	for (const [i, id] of ids.entries()) {
		await sql`insert into posts (id,user_id,text,conversation_id,hidden) values (${id}::bigint,${author}::bigint,${`saved ${i}`},${id}::bigint,${i === 203})`;
		await sql`insert into bookmark_folder_posts (folder_id,post_id,created_at) values (${folder}::bigint,${id}::bigint,'2026-01-01 00:00:00.123456+00')`;
	}
	const first = entries(await h.BookmarkFolderTimeline(v, { bookmark_collection_id: folder }));
	assert.equal(postIds(first).length, 100);
	const next = cursor(first); assert(next);
	// Removing the anchor must not invalidate a cursor, or skip the remaining entries.
	const anchor = postIds(first).at(-1)!;
	await sql`delete from bookmark_folder_posts where folder_id=${folder}::bigint and post_id=${anchor}::bigint`;
	const second = entries(await h.BookmarkFolderTimeline(v, { bookmark_collection_id: folder, cursor: next }));
	assert.equal(postIds(second).length, 100);
	const third = entries(await h.BookmarkFolderTimeline(v, { bookmark_collection_id: folder, cursor: cursor(second) }));
	assert.equal(postIds(third).length, 4);
	assert.equal(cursor(third), undefined);
	const all = [...postIds(first), ...postIds(second), ...postIds(third)];
	const indices = [...first, ...second, ...third].map((entry: any) => BigInt(entry.sortIndex));
	assert(indices.every((value, i) => i === 0 || value < indices[i - 1]), "later pages keep descending timeline sort indices");
	assert.equal(new Set(all).size, 204);
	assert.deepEqual(all, ids.filter((_, i) => i !== 203).reverse());
	await assert.rejects(() => h.BookmarkFolderTimeline({ id: foreign } as Viewer, { bookmark_collection_id: folder, cursor: next }), (e: unknown) => e instanceof PostError && e.code === 144);
	assert.equal((await folderPosts(foreign, folder)).posts.length, 0);
	for (const invalid of ["junk", {}, ...["2026-99-99 00:00:00+00", "2026-02-30 00:00:00+00", "2026-01-01 24:00:00+00"].map((at) => Buffer.from(JSON.stringify({ at, id: anchor, sort: newId() })).toString("base64url")), Buffer.from(JSON.stringify({ at: "2026-01-01 00:00:00+00", id: "9223372036854775808", sort: newId() })).toString("base64url")])
		await assert.rejects(() => h.BookmarkFolderTimeline(v, { bookmark_collection_id: folder, cursor: invalid }), (e: unknown) => e instanceof PostError && e.code === 214);
	await sql`update users set protected=true where id=${author}::bigint`;
	assert.equal(postIds(entries(await h.BookmarkFolderTimeline(v, { bookmark_collection_id: folder }))).length, 0);
	console.log("Bookmark pagination passed: 204 visible posts across three pages, stable tied timestamps, deleted anchor, ownership, malformed cursors, protected and hidden posts");
} finally {
	await sql`delete from users where id in (${user}::bigint,${author}::bigint,${foreign}::bigint)`;
	await sql.close();
}
