import type { SQL } from "bun";
import { sql } from "./db";
import { INSTANCE_ID } from "./federation";
import { linksIn } from "./links";

export const MENTION_HANDLE = /(?<![\w@])@(\w{1,50})(?!\w)(?:@((?:[a-z0-9-]+\.)*[a-z0-9-]+(?::\d{1,5})?))?/gi;

export const homeOf = (screenName: string) => (screenName.includes("@") ? screenName.slice(screenName.indexOf("@") + 1).toLowerCase() : undefined);

export function mentionKey(name: string, host: string | undefined, from?: string): string {
	const n = name.toLowerCase();
	const h = host?.toLowerCase();
	if (h === INSTANCE_ID) return n;
	if (h) return `${n}@${h}`;
	return from ? `${n}@${from}` : n;
}

export function mentionsIn(text: string, from?: string): { key: string; start: number; end: number }[] {
	const links = linksIn(text);
	const out = [];
	for (const m of text.matchAll(MENTION_HANDLE)) {
		const start = [...text.slice(0, m.index)].length;
		const end = start + [...m[0]].length;
		if (links.some((l) => start < l.end && end > l.start)) continue;
		out.push({ key: mentionKey(m[1], m[2], from), start, end });
	}
	return out;
}

export function mentionHandles(text: string, from?: string): string[] {
	return [...new Set(mentionsIn(text, from).map((m) => m.key))].slice(0, 20);
}

export async function saveMentions(postId: string, text: string, from?: string, lookup?: (handle: string) => Promise<unknown>, db: SQL = sql) {
	const names = mentionHandles(text, from);
	if (lookup) {
		const remote = names.filter((n) => n.includes("@"));
		if (remote.length) {
			const known = new Set((await db`select lower(screen_name) as n from users where lower(screen_name) = any(${sql.array(remote, "TEXT")})`).map((r: { n: string }) => r.n));
			await Promise.race([Promise.all(remote.filter((n) => !known.has(n)).map((n) => lookup(n).catch(() => undefined))), Bun.sleep(3000)]);
		}
	}
	await db`delete from post_mentions where post_id = ${postId}::bigint`;
	if (names.length)
		await db`insert into post_mentions (post_id, user_id)
			select ${postId}::bigint, u.id from users u where lower(u.screen_name) = any(${sql.array(names, "TEXT")}) and not u.instance_blocked on conflict do nothing`;
}
