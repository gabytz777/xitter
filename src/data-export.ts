// Settings > Your account > Download an archive of your data. The archive is
// made on the spot (JSON) and kept in the database for the person to fetch.
import type { SQL } from "bun";
import { sql } from "./db";
import { newId } from "./ids";
import type { Viewer } from "./auth";
import * as thrift from "./thrift";
import { exportHtml } from "./export-html";

const json = (body: unknown, status = 200) => Response.json(body, { status });

// JS's Date.toJSON form, which the archive has always used
const iso = (column: ReturnType<typeof sql>) => sql`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const list = (query: ReturnType<typeof sql>) => sql`coalesce((select jsonb_agg(to_jsonb(x)) from (${query}) x), '[]'::jsonb)`;

// Match the message-history endpoints, including audience-specific and local
// deletions. Use this predicate again at final assembly after staging details.
const visibleChat = (userId: string) => sql`m.user_id = ${userId}::bigint
	and not e.deleted and (e.audience_id is null or e.audience_id = ${userId}::bigint)
	and e.seq > m.deleted_before and not exists (select 1 from chat_hidden_events h where h.user_id = ${userId}::bigint and h.seq = e.seq)
	and e.kind in (1, 4, 7, 8, 12, 13)`;

async function stageChat(tx: SQL, userId: string) {
	// Stored envelopes contain a signed conversation token and key-change
	// events can contain wrapped keys. Stage only recognized non-key details,
	// never complete envelopes or public/private key records.
	await tx`create temporary table data_export_chat_details (
		seq bigint primary key, conversation_id text not null, sender_id bigint not null,
		kind smallint not null, source_hash text not null, detail_base64 text not null
	) on commit drop`;
	const [upper] = await tx`select max(seq)::text as seq from chat_events`;
	if (!upper.seq) return;
	let after = "0";
	for (;;) {
		// Bound both row count and bytes. A single large event is processed alone;
		// otherwise at most 1 MiB of event blobs reaches JS in each batch.
		const rows = await tx`with candidates as (
			select e.seq, e.conversation_id, e.sender_id, e.kind, e.event from chat_events e
			join chat_members m on m.conversation_id = e.conversation_id
			where ${visibleChat(userId)} and e.seq > ${after}::bigint and e.seq <= ${upper.seq}::bigint
			order by e.seq limit 128
		), sized as (
			select *, sum(octet_length(event)) over (order by seq) as bytes,
				row_number() over (order by seq) as n from candidates
		) select seq::text, conversation_id, sender_id::text, kind, event, encode(sha256(event), 'hex') as source_hash
			from sized where bytes <= 1048576 or n = 1 order by seq`;
		if (!rows.length) break;
		const details: { seq: string; conversation_id: string; sender_id: string; kind: number; source_hash: string; detail_base64: string }[] = [];
		for (const row of rows) {
			try {
				const detail = thrift.fields(thrift.decode(new Uint8Array(row.event))[7]);
				const value = detail?.[row.kind];
				if (value?.t !== thrift.T.struct) continue;
				// Select just the recognized union member: a malformed envelope must
				// not smuggle a key-change sibling alongside a message detail.
				details.push({ seq: row.seq, conversation_id: row.conversation_id, sender_id: row.sender_id,
					kind: row.kind, source_hash: row.source_hash,
					detail_base64: Buffer.from(thrift.encode({ [row.kind]: value })).toString("base64") });
			} catch {
				// Invalid historical blobs cannot safely be exported as raw envelopes.
			}
		}
		if (details.length) await tx`insert into pg_temp.data_export_chat_details
			select x.* from jsonb_to_recordset(${JSON.stringify(details)}::text::jsonb)
				as x(seq bigint, conversation_id text, sender_id bigint, kind smallint, source_hash text, detail_base64 text)`;
		after = rows[rows.length - 1].seq;
	}
}

// The database assembles and stores the archive without copying its full body
// through JS. Encrypted chat details are sanitized in bounded batches first.
async function build(tx: SQL, viewer: Viewer, exportId: string) {
	const id = viewer.id;
	await stageChat(tx, id);
	await tx`insert into data_exports (id, user_id, body) select ${exportId}::bigint, ${id}::bigint, jsonb_build_object(
		'generated_at', ${new Date().toISOString()}::text,
		'account', (select to_jsonb(x) from (select screen_name, name, bio, location, website, email, language, protected, ${iso(sql`created_at`)} as created_at
			from users where id = ${id}::bigint) x),
		'posts', ${list(sql`select id::text as id, text, ${iso(sql`created_at`)} as created_at, reply_to_id::text as reply_to_id, poll_id::text as poll_id, conversation_card, conversation_card_post_id::text from posts where user_id = ${id}::bigint order by id`)},
		'drafts', ${list(sql`select id::text as id, request, ${iso(sql`created_at`)} as created_at from scheduled_posts where user_id = ${id}::bigint and kind = 'draft' order by id`)},
		'scheduled_posts', ${list(sql`select id::text as id, request, ${iso(sql`execute_at`)} as execute_at, ${iso(sql`created_at`)} as created_at from scheduled_posts where user_id = ${id}::bigint and kind = 'scheduled' order by execute_at, id`)},
		'polls', ${list(sql`select p.id::text as id, p.choices, p.duration_minutes,
			${iso(sql`p.ends_at`)} as ends_at, ${iso(sql`p.created_at`)} as created_at,
			case when p.choice_media is null then null else (select array_agg(m.id::text order by choice.n)
				from unnest(p.choice_media) with ordinality as choice(media_id, n)
				left join media m on m.id = choice.media_id and m.user_id = ${id}::bigint) end as choice_media
			from polls p where p.user_id = ${id}::bigint order by p.id`)},
		'poll_votes', ${list(sql`select poll_id::text as poll_id, choice, ${iso(sql`created_at`)} as created_at
			from poll_votes where user_id = ${id}::bigint order by created_at, poll_id`)},
		'media', ${list(sql`select id::text as id, kind, mime, size, width, height, post_id::text as post_id, position,
			duration_ms, alt_text, sensitive_warning, state, detached, ${iso(sql`created_at`)} as created_at
			from media where user_id = ${id}::bigint order by id`)},
		'bookmark_folders', ${list(sql`select id::text as id, name, ${iso(sql`created_at`)} as created_at
			from bookmark_folders where user_id = ${id}::bigint order by created_at, id`)},
		'bookmark_folder_posts', ${list(sql`select fp.folder_id::text as folder_id, fp.post_id::text as post_id, ${iso(sql`fp.created_at`)} as created_at
			from bookmark_folder_posts fp join bookmark_folders f on f.id = fp.folder_id
			join bookmarks b on b.post_id = fp.post_id and b.user_id = ${id}::bigint
			where f.user_id = ${id}::bigint order by fp.folder_id, fp.created_at, fp.post_id`)},
		'chat', jsonb_build_object(
			'format', 'xitter-chat-event-details', 'version', 1,
			'event_detail_encoding', 'thrift-binary-base64', 'message_content', 'end-to-end encrypted', 'includes_decryption_keys', false,
			'conversations', ${list(sql`select m.conversation_id as id, c.creator_id::text as creator_id,
				(select coalesce(jsonb_agg(peer.user_id::text order by peer.user_id), '[]'::jsonb) from chat_members peer where peer.conversation_id = m.conversation_id) as participant_ids,
				${iso(sql`m.joined_at`)} as joined_at, m.accepted, m.archived, m.muted, m.deleted_before::text as deleted_before,
				case when c.id is null then null else jsonb_build_object(
					'group_name', case when jsonb_typeof(c.metadata->'group_name') = 'string' then c.metadata->'group_name' else null end, 'description', case when jsonb_typeof(c.metadata->'description') = 'string' then c.metadata->'description' else null end,
					'created_at_msec', case when jsonb_typeof(c.metadata->'created_at_msec') = 'string' then c.metadata->'created_at_msec' else null end, 'updated_at_msec', case when jsonb_typeof(c.metadata->'updated_at_msec') = 'string' then c.metadata->'updated_at_msec' else null end,
					'message_ttl_msec', case when jsonb_typeof(c.metadata->'message_ttl_msec') = 'string' then c.metadata->'message_ttl_msec' else null end, 'group_type', case when jsonb_typeof(c.metadata#>'{classification,group_type}') = 'string' then c.metadata#>'{classification,group_type}' else null end,
					'admin_settings', jsonb_build_object('add_member', case when jsonb_typeof(c.metadata#>'{admin_settings,add_member}') = 'boolean' then c.metadata#>'{admin_settings,add_member}' else null end,
						'edit_group_info', case when jsonb_typeof(c.metadata#>'{admin_settings,edit_group_info}') = 'boolean' then c.metadata#>'{admin_settings,edit_group_info}' else null end, 'send_message', case when jsonb_typeof(c.metadata#>'{admin_settings,send_message}') = 'boolean' then c.metadata#>'{admin_settings,send_message}' else null end,
						'start_call', case when jsonb_typeof(c.metadata#>'{admin_settings,start_call}') = 'boolean' then c.metadata#>'{admin_settings,start_call}' else null end, 'edit_message_ttl', case when jsonb_typeof(c.metadata#>'{admin_settings,edit_message_ttl}') = 'boolean' then c.metadata#>'{admin_settings,edit_message_ttl}' else null end,
						'block_screen_capture', case when jsonb_typeof(c.metadata#>'{admin_settings,block_screen_capture}') = 'boolean' then c.metadata#>'{admin_settings,block_screen_capture}' else null end)) end as metadata
				from chat_members m left join chat_conversations c on c.id = m.conversation_id
				where m.user_id = ${id}::bigint order by m.conversation_id`)},
			'events', ${list(sql`select e.seq::text as seq, e.conversation_id, e.sender_id::text as sender_id, e.kind,
				${iso(sql`e.created_at`)} as created_at, staged.detail_base64 as event_detail_base64
				from pg_temp.data_export_chat_details staged join chat_events e on e.seq = staged.seq
					and e.conversation_id = staged.conversation_id and e.sender_id = staged.sender_id and e.kind = staged.kind
				join chat_members m on m.conversation_id = e.conversation_id
				where ${visibleChat(id)} and encode(sha256(e.event), 'hex') = staged.source_hash order by e.seq`)}
		),
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
	urls: [`/i/api/xitter/export/${r.id}`, `/i/api/xitter/export/${r.id}.html`],
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
	const m = /^\/xitter\/export\/(\d{1,19})(\.html)?$/.exec(path);
	if (m && method === "GET") {
		const [row] = await sql`select ${m[2] ? sql`body` : sql`jsonb_pretty(body)`} as body from data_exports where id = ${m[1]}::bigint and user_id = ${viewer.id}::bigint`;
		if (!row) return json({ errors: [{ code: 34, message: "Sorry, that page does not exist." }] }, 404);
		const filename = viewer.screen_name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 50) || "account";
		return new Response(m[2] ? exportHtml(row.body as Record<string, unknown>) : row.body, {
			headers: { "content-type": m[2] ? "text/html; charset=utf-8" : "application/json", "content-disposition": `attachment; filename="${filename}-data.${m[2] ? "html" : "json"}"`, "cache-control": "no-store", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'" },
		});
	}
	return undefined;
}
