// Run against a migrated disposable PostgreSQL database.
import { strict as assert } from "node:assert";
import { sql } from "../src/db";
import { newId } from "../src/ids";
import type { Viewer } from "../src/auth";
import { noteAppealsRoute } from "../src/note-appeals";
import { settings } from "../src/settings";
import { PUBLIC_ORIGIN } from "../src/config";

const database = new URL(process.env.DATABASE_URL ?? "postgres://localhost/xitter");
assert(["localhost", "127.0.0.1"].includes(database.hostname) && /test|codex/.test(database.pathname), "Use a disposable local test database.");

const ids = Array.from({ length: 8 }, () => newId());
const [author, postAuthor, staff, ...voters] = ids;
const post = newId(), note = newId();
const viewer = (id: string, role: Viewer["role"] = null) => ({ id, screen_name: `notes_${id}`, status: "active", role, csrf: `csrf-${id}` }) as Viewer;
const form = async (who: Viewer, fields: Record<string, string>) => noteAppealsRoute(new Request(`${PUBLIC_ORIGIN}/account/notes/appeals`, {
	method: "POST", headers: { origin: PUBLIC_ORIGIN, "content-type": "application/x-www-form-urlencoded" },
	body: new URLSearchParams({ csrf: who.csrf, note_id: note, ...fields }),
}), who);

try {
	for (const id of ids) await sql`insert into users(id, screen_name, name, password_hash) values(${id}::bigint, ${`notes_${id}`}, 'Notes test', 'unused')`;
	await sql`insert into posts(id, user_id, text, conversation_id) values(${post}::bigint, ${postAuthor}::bigint, 'A post', ${post}::bigint)`;
	await sql`insert into community_notes(id, post_id, author_id, text, classification) values(${note}::bigint, ${post}::bigint, ${author}::bigint, 'A note to review', 'Misleading')`;
	for (const id of voters) await sql`insert into community_note_ratings(note_id, user_id, rating) values(${note}::bigint, ${id}::bigint, 'NotHelpful')`;
	const owner = viewer(author), reviewer = viewer(staff, "moderator");
	assert.equal((await form(viewer(postAuthor), { action: "appeal", reason: "I disagree with these ratings." })).status, 403, "only note author can appeal");
	assert.equal((await form(owner, { action: "appeal", csrf: "wrong", reason: "I disagree with these ratings." })).status, 403, "CSRF required");
	assert.equal((await form(owner, { action: "appeal", reason: "The linked source supports this context." })).status, 200);
	assert.equal((await form(owner, { action: "appeal", reason: "The linked source supports this context." })).status, 409, "one appeal per note");
	assert.equal((await form(viewer(postAuthor), { action: "review", outcome: "accepted", resolution: "Reasonable appeal." })).status, 403, "only staff reviews");
	settings().security.staff_2fa = true;
	try {
		assert.equal((await form(reviewer, { action: "review", outcome: "accepted", resolution: "Reasonable appeal." })).status, 403, "staff security gate applies");
	} finally { settings().security.staff_2fa = false; }
	assert.equal((await form(reviewer, { action: "review", outcome: "accepted", resolution: "The source supports the author's context." })).status, 200);
	const [appeal] = await sql`select status, reviewed_by::text from community_note_appeals where note_id = ${note}::bigint`;
	assert.equal(appeal.status, "accepted");
	assert.equal(appeal.reviewed_by, staff);
	assert.equal((await form(reviewer, { action: "review", outcome: "rejected", resolution: "A second decision." })).status, 404, "decision is final");
	console.log("Community Notes appeal ownership, CSRF, review, and audit checks passed");
} finally {
	await sql`delete from users where id = any(${sql.array(ids, "INT8")})`;
	await sql.close();
}
