import { sql } from "./db";
import { INSTANCE_ID } from "./federation";

export const MENTION_HANDLE = /(?<![\w@])@(\w{1,15})(?:@((?:[a-z0-9-]+\.)*[a-z0-9-]+(?::\d{1,5})?))?/gi;

export function mentionHandles(text: string, from?: string): string[] {
	const names = [...text.matchAll(MENTION_HANDLE)].map((m) => {
		const name = m[1].toLowerCase();
		const host = m[2]?.toLowerCase();
		if (host === INSTANCE_ID) return name;
		if (host) return `${name}@${host}`;
		return from ? `${name}@${from}` : name;
	});
	return [...new Set(names)].slice(0, 20);
}

export async function saveMentions(postId: string, text: string, from?: string, lookup?: (handle: string) => Promise<unknown>) {
	const names = mentionHandles(text, from);
	if (lookup) {
		const remote = names.filter((n) => n.includes("@"));
		if (remote.length) {
			const known = new Set((await sql`select lower(screen_name) as n from users where lower(screen_name) = any(${sql.array(remote, "TEXT")})`).map((r: { n: string }) => r.n));
			await Promise.race([Promise.all(remote.filter((n) => !known.has(n)).map((n) => lookup(n).catch(() => undefined))), Bun.sleep(3000)]);
		}
	}
	await sql`delete from post_mentions where post_id = ${postId}::bigint`;
	if (names.length)
		await sql`insert into post_mentions (post_id, user_id)
			select ${postId}::bigint, u.id from users u where lower(u.screen_name) = any(${sql.array(names, "TEXT")}) and not u.instance_blocked on conflict do nothing`;
}
