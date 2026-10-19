// Settings > Your account > Download an archive of your data. The archive is
// made on the spot (JSON) and kept in the database for the person to fetch.
import type { SQL } from "bun";
import { sql } from "./db";
import { newId } from "./ids";
import type { Viewer } from "./auth";

const json = (body: unknown, status = 200) => Response.json(body, { status });

// JS's Date.toJSON form, which the archive has always used
const iso = (column: ReturnType<typeof sql>) => sql`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const list = (query: ReturnType<typeof sql>) => sql`coalesce((select jsonb_agg(to_jsonb(x)) from (${query}) x), '[]'::jsonb)`;

// The archive is put together and stored by the database in one statement:
// built in memory, an account with many posts held several copies of it.
async function build(tx: SQL, viewer: Viewer, exportId: string) {
	const id = viewer.id;
	await tx`insert into data_exports (id, user_id, body) select ${exportId}::bigint, ${id}::bigint, jsonb_build_object(
		'generated_at', ${new Date().toISOString()}::text,
		'account', (select to_jsonb(x) from (select screen_name, name, bio, location, website, email, language, protected, ${iso(sql`created_at`)} as created_at
			from users where id = ${id}::bigint) x),
		'posts', ${list(sql`select id::text as id, text, ${iso(sql`created_at`)} as created_at, reply_to_id::text as reply_to_id from posts where user_id = ${id}::bigint order by id`)},
		'drafts', ${list(sql`select id::text as id, request, ${iso(sql`created_at`)} as created_at from scheduled_posts where user_id = ${id}::bigint and kind = 'draft' order by id`)},
		'scheduled_posts', ${list(sql`select id::text as id, request, ${iso(sql`execute_at`)} as execute_at, ${iso(sql`created_at`)} as created_at from scheduled_posts where user_id = ${id}::bigint and kind = 'scheduled' order by execute_at, id`)},
		'likes', ${list(sql`select post_id::text as post_id, ${iso(sql`created_at`)} as created_at from likes where user_id = ${id}::bigint order by likes.created_at`)},
		'bookmarks', ${list(sql`select post_id::text as post_id, ${iso(sql`created_at`)} as created_at from bookmarks where user_id = ${id}::bigint order by bookmarks.created_at`)},
		'following', ${list(sql`select u.screen_name, ${iso(sql`f.created_at`)} as created_at from follows f join users u on u.id = f.followee_id where f.follower_id = ${id}::bigint`)},
		'followers', ${list(sql`select u.screen_name, ${iso(sql`f.created_at`)} as created_at from follows f join users u on u.id = f.follower_id where f.followee_id = ${id}::bigint`)},
		'blocked', ${list(sql`select u.screen_name from blocks b join users u on u.id = b.blocked_id where b.blocker_id = ${id}::bigint`)},
		'muted', ${list(sql`select u.screen_name from mutes m join users u on u.id = m.muted_id where m.muter_id = ${id}::bigint`)}
	)`;
}

const entry = (r: any) => ({
	id: r.id,
	status: "COMPLETED",
	created_at: new Date(r.created_at).toISOString(),
	urls: [`/i/api/xitter/export/${r.id}`],
});

export async function dataExportRoute(method: string, path: string, viewer: Viewer, req: Request): Promise<Response | undefined> {
	if (path === "/1.1/account/user_twitter_data") {
		if (method === "GET") {
			const rows = await sql`select id::text, created_at from data_exports where user_id = ${viewer.id}::bigint order by created_at desc limit 5`;
			return json(rows.map(entry));
		}
		if (method === "POST") {
			await sql.begin(async (tx) => {
				// Lock before checking the daily limit so concurrent requests (including
				// requests handled by another server) cannot store duplicate full copies.
				await tx`select id from users where id = ${viewer.id}::bigint for update`;
				await tx`delete from data_exports where user_id = ${viewer.id}::bigint and created_at < now() - interval '7 days'`;
				const [recent] = await tx`select 1 from data_exports where user_id = ${viewer.id}::bigint and created_at > now() - interval '1 day' limit 1`;
				if (!recent) await build(tx, viewer, newId());
			});
			return json({ status: "ok" });
		}
		if (method === "PUT") return json({ status: "ok" });
	}
	if (path === "/1.1/account/personalization/email_your_data" && method === "POST") return json({ status: "ok" });
	const m = /^\/xitter\/export\/(\d{1,19})$/.exec(path);
	if (m && method === "GET") {
		// formatted by the database, so the archive reaches us once, as text
		const [row] = await sql`select jsonb_pretty(body) as body from data_exports where id = ${m[1]}::bigint and user_id = ${viewer.id}::bigint`;
		if (!row) return json({ errors: [{ code: 34, message: "Sorry, that page does not exist." }] }, 404);
		return new Response(row.body, {
			headers: { "content-type": "application/json", "content-disposition": `attachment; filename="${viewer.screen_name}-data.json"`, "cache-control": "no-store" },
		});
	}
	return undefined;
}
