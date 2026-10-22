// Admin > OAuth apps: every app that can ask for access here, registered ones
// and those identified by a client ID metadata document (which have no owner,
// so no developer page shows them). Staff block a bad one: its grants end and
// it can't ask again until unblocked. A block can name a document URL before
// anyone has approved it.
import { type Action, AdminError, audit, idOf } from "./admin";
import { sql } from "./db";
import { newId } from "./ids";
import { metadataClientId } from "./oauth-metadata";

const reasonOf = (v: unknown) => (typeof v === "string" ? v.trim().slice(0, 500) : "");

export const oauthAppActions: Record<string, Action> = {
	oauthApps: {
		role: "support",
		run: async () => ({
			apps: await sql`select c.id::text, c.name, c.redirect_uri, c.metadata_url, c.revoked, c.blocked_at, c.blocked_reason, c.created_at, u.screen_name as owner,
				(select count(*)::int from api_tokens t where t.client_id = c.id and (t.expires_at is null or t.expires_at > now())) as grants
				from oauth_clients c left join users u on u.id = c.owner_id order by c.created_at desc limit 500`,
		}),
	},
	blockOAuthApp: {
		role: "moderator",
		run: async (a, b) => {
			const reason = reasonOf(b.reason);
			let id: string;
			if (typeof b.url === "string" && b.url.trim()) {
				const url = b.url.trim();
				if (!metadataClientId(url)) throw new AdminError("Enter the app's client ID: an https address like https://app.example/oauth-client.json.");
				[{ id }] = await sql`insert into oauth_clients(id, owner_id, name, redirect_uri, metadata_url) values(${newId()}::bigint, null, ${new URL(url).host}, ${url}, ${url})
					on conflict (metadata_url) do update set metadata_url = excluded.metadata_url returning id::text`;
			} else id = idOf(b.id, "app");
			const done = await sql.begin(async (tx) => {
				const rows = await tx`update oauth_clients set revoked = true, blocked_at = now(), blocked_reason = ${reason || null} where id = ${id}::bigint returning id`;
				if (!rows.length) return false;
				await tx`delete from api_tokens where client_id = ${id}::bigint`;
				await tx`delete from oauth_codes where client_id = ${id}::bigint`;
				return true;
			});
			if (!done) throw new AdminError("No such app.", 404);
			await audit(a, "block_oauth_app", id, { reason, url: typeof b.url === "string" ? b.url.trim() || undefined : undefined });
			return {};
		},
	},
	unblockOAuthApp: {
		role: "moderator",
		run: async (a, b) => {
			const id = idOf(b.id, "app");
			// only staff blocks lift: an app its developer revoked stays revoked
			const rows = await sql`update oauth_clients set revoked = false, blocked_at = null, blocked_reason = null where id = ${id}::bigint and blocked_at is not null returning id`;
			if (!rows.length) throw new AdminError("That app isn't blocked by staff.", 404);
			await audit(a, "unblock_oauth_app", id);
			return {};
		},
	},
};
