// A Grok-like assistant. When someone posts that mentions the assistant account,
// or replies to it, it answers with a completion from a very small local model.
// The model is tiny on purpose, so the answers are confidently, hilariously
// wrong — that is the whole point. It can only manage one blunt instruction and
// still echoes the post sometimes; the guards below exist for the worst of that.
//
// GROK_HANDLE names the account; with it unset nothing here runs. GROK_MODEL_URL
// points at the model server (llama.cpp, OpenAI-compatible) and GROK_MODEL names
// the model that server loads (it is that service's own setting, not ours).

import { sql } from "./db";
import { createPost } from "./posts";

const INTERVAL_MS = 20_000;
// keep well under a post's length limit
const MAX_CHARS = 250;
// Only answer what arrives after this process started, so turning the assistant
// on never replays a backlog of old mentions.
const startedAt = new Date();

const handle = () => (process.env.GROK_HANDLE ?? "").trim().replace(/^@/, "").toLowerCase();
const modelUrl = () => (process.env.GROK_MODEL_URL ?? "http://llm:8080").replace(/\/+$/, "");

type Candidate = { id: string; text: string; screen_name: string };

// The posts the assistant owes an answer to: ones naming it or replying to it,
// from accounts that can post, with no answer from it yet.
async function unanswered(grokId: string): Promise<Candidate[]> {
	return (await sql`
		select p.id::text as id, p.text, u.screen_name
		from posts p
		join users u on u.id = p.user_id
		where p.user_id <> ${grokId}::bigint
			and p.created_at > ${startedAt}
			and u.status is distinct from 'suspended'
			and u.status is distinct from 'restricted'
			and (
				exists (select 1 from post_mentions m where m.post_id = p.id and m.user_id = ${grokId}::bigint)
				or p.reply_to_user_id = ${grokId}::bigint
			)
			and not exists (select 1 from posts r where r.reply_to_id = p.id and r.user_id = ${grokId}::bigint)
		order by p.created_at
		limit 3`) as Candidate[];
}

// The model copies what it is shown, so keep mentions and links out of the
// prompt: echoing "@grok" back at the poster is the one failure mode that reads
// as broken rather than merely silly.
const strip = (s: string) =>
	s
		.replace(/@[A-Za-z0-9_]{1,15}/g, "")
		.replace(/https?:\/\/\S+/g, "")
		.replace(/\s+/g, " ")
		.trim();

const tidy = (s: string) =>
	s
		.replace(/\s+/g, " ")
		.replace(/^[\s"'“”‘’]*(?:grok|assistant|answer|reply|bot)\s*[:\-]\s*/i, "")
		.replace(/^[\s"'“”‘’]+/, "")
		.replace(/[\s"'“”‘’]+$/, "")
		.trim();

const clamp = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n).replace(/\s+\S*$/, "")}…`);

const words = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean));

// True when the "reply" is the post handed straight back. A model this small
// does that often, and it is worse than saying nothing.
const isEcho = (reply: string, post: string) => {
	const a = words(reply);
	const b = words(strip(post));
	if (!a.size || !b.size) return true;
	let shared = 0;
	for (const w of a) if (b.has(w)) shared++;
	return shared / a.size > 0.85;
};

// One completion from the local model. Returns nothing when the model server is
// down or answers with nothing, so the caller leaves the post unanswered and
// tries again on the next tick rather than posting an empty reply.
async function complete(text: string): Promise<string | undefined> {
	const res = await fetch(`${modelUrl()}/v1/chat/completions`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		signal: AbortSignal.timeout(180_000),
		body: JSON.stringify({
			// the server holds exactly one model, so its name here is a formality
			model: "grok",
			stream: false,
			temperature: 0.9,
			// keep it terse: this host is slow and a long answer costs the site CPU
			max_tokens: 60,
			// a 135M model drifts into "I'm gonna have you know I'm gonna..." without
			// these; the prompt is one blunt instruction because it can't hold more
			frequency_penalty: 0.8,
			presence_penalty: 0.6,
			messages: [{ role: "user", content: `Someone posted this on a social network:\n\n"${text}"\n\nWrite one short, funny reply to it. Do not repeat the post.` }],
		}),
	});
	if (!res.ok) throw new Error(`model returned ${res.status}`);
	const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
	const out = tidy(String(body.choices?.[0]?.message?.content ?? ""));
	return out ? clamp(out, MAX_CHARS) : undefined;
}

// A post the model fumbled is retried a couple of times and then left alone, so
// a weak model can't spin forever on one mention.
const attempts = new Map<string, number>();
const MAX_ATTEMPTS = 3;

async function tick(): Promise<void> {
	const wanted = handle();
	if (!wanted) return;
	const [grok] = await sql`select id::text as id from users where lower(screen_name) = ${wanted}`;
	if (!grok) {
		console.error(`grok: no @${wanted} account; run scripts/grok-setup.ts`);
		return;
	}
	for (const post of await unanswered(grok.id)) {
		if ((attempts.get(post.id) ?? 0) >= MAX_ATTEMPTS) continue;
		const failed = () => attempts.set(post.id, (attempts.get(post.id) ?? 0) + 1);
		try {
			const reply = await complete(strip(post.text));
			if (!reply || isEcho(reply, post.text)) {
				failed();
				continue;
			}
			await createPost(grok.id, reply, { replyToId: post.id });
			attempts.delete(post.id);
		} catch (e) {
			// the model is slow and this host is small; a miss waits for the next tick
			console.error("grok:", e instanceof Error ? e.message : e);
			failed();
			return;
		}
	}
}

export function startGrok() {
	if (!handle()) return;
	setInterval(() => void tick().catch((e) => console.error("grok:", e)), INTERVAL_MS).unref();
}
