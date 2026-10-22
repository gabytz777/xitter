// Account migration end to end, between two running instances with their own
// disposable databases (docker/migration-test.yaml starts a pair):
//   A_URL=http://localhost:3101 A_DATABASE_URL=postgres://... A_MEDIA_DIR=...
//   B_URL=http://localhost:3102 B_DATABASE_URL=postgres://... B_MEDIA_DIR=...
//   bun scripts/test-migration.ts
// Both servers need MIGRATION_ALLOW_HTTP=1 and MIGRATION_ALLOW_PRIVATE=1. B
// reaches A at A_FROM_B (A_URL by default). A_ORIGIN and B_ORIGIN are their
// PUBLIC_ORIGINs when the URLs used here differ, as inside Compose:
//   docker compose -f docker/migration-test.yaml exec \
//     -e A_URL=http://app-a:3000 -e B_URL=http://app-b:3000 \
//     -e A_ORIGIN=http://localhost:3101 -e B_ORIGIN=http://localhost:3102 \
//     -e A_DATABASE_URL=postgres://xitter:test@db:5432/xit_a \
//     -e B_DATABASE_URL=postgres://xitter:test@db:5432/xit_b \
//     -e A_MEDIA_DIR=/app/media/a -e B_MEDIA_DIR=/app/media/b \
//     app-a bun scripts/test-migration.ts
// A_MEDIA_DIR is where A keeps its files, for the seeded picture.
// It seeds an account on A, moves it into a fresh account on B and checks what
// arrived, that a second run adds nothing, and that A recorded the move.
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SQL } from "bun";

const env = (k: string) => {
	const v = process.env[k];
	if (!v) throw new Error(`set ${k}`);
	return v;
};
const A = env("A_URL"), B = env("B_URL");
const A_FROM_B = process.env.A_FROM_B ?? A;
const a = new SQL(env("A_DATABASE_URL"));
const b = new SQL(env("B_DATABASE_URL"));
for (const u of [env("A_DATABASE_URL"), env("B_DATABASE_URL")]) assert(/test|xit_|migration/.test(new URL(u).pathname), "Use disposable test databases.");
const aMedia = process.env.A_MEDIA_DIR, bMedia = process.env.B_MEDIA_DIR;

const host = (url: string) => new URL(url).host;
const A_ID = host(process.env.A_ORIGIN ?? A);
const B_ORIGIN = process.env.B_ORIGIN ?? B;
const tag = Date.now().toString(36).slice(-5);
const PASSWORD = "migration-test-pw";
// a 1x1 PNG
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000" + "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082", "hex");

const EPOCH = 1288834974657n;
let seq = 0n;
const idAt = (ms: number) => (((BigInt(ms) - EPOCH) << 22n) | (seq++ & 0xfffn)).toString();
const day = 86400_000;
const past = (days: number) => Date.now() - days * day;

async function user(db: SQL, name: string, extra: Record<string, unknown> = {}) {
	const id = idAt(past(400));
	const hash = await Bun.password.hash(PASSWORD);
	await db`insert into users ${db({ id, screen_name: name, name: `${name} test`, password_hash: hash, ...extra })}`;
	return id;
}

type Session = { cookie: string; csrf: string };
async function signIn(base: string, name: string): Promise<Session> {
	const r = await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ username: name, password: PASSWORD }), redirect: "manual" });
	assert(r.status < 400, `sign in to ${base} as ${name}: ${r.status} ${await r.text()}`);
	const cookies = r.headers.getSetCookie().map((c) => c.split(";")[0]);
	return { cookie: cookies.join("; "), csrf: cookies.find((c) => c.startsWith("ct0="))!.slice(4) };
}
async function form(base: string, s: Session, fields: Record<string, string>) {
	const r = await fetch(`${base}/account/migrate`, {
		method: "POST",
		redirect: "manual",
		headers: { cookie: s.cookie, origin: base, "sec-fetch-site": "same-origin" },
		body: new URLSearchParams({ csrf: s.csrf, ...fields }),
	});
	return { status: r.status, html: await r.text(), location: r.headers.get("location") };
}
const field = (html: string, name: string) => new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1];
const newCode = async (s: Session) => {
	const r = await form(A, s, { action: "code", password: PASSWORD });
	const code = /xmig_[A-Za-z0-9_-]{43}/.exec(r.html)?.[0];
	assert(code, `A made a migration code: ${r.status}`);
	return code;
};
async function waitForJob(userId: string) {
	for (let i = 0; i < 120; i++) {
		const [job] = await b`select state, error, report from account_migrations where user_id = ${userId}::bigint order by created_at desc limit 1`;
		if (job && job.state !== "running") return job;
		await Bun.sleep(500);
	}
	throw new Error("the import didn't finish in a minute");
}
const one = async (q: Promise<any[]>) => (await q)[0];
const n = async (q: Promise<any[]>) => Number((await q)[0].n);

// --- seed A: alice, who moves, with bob and carol around her
const alice = await user(a, `alice_${tag}`, { bio: "hello from A", location: "Lisbon", website: "https://example.org", pronouns: "she/her" });
const bob = await user(a, `bob_${tag}`);
const carol = await user(a, `carol_${tag}`);
const photo = idAt(past(30)), avatar = idAt(past(30));
for (const id of [photo, avatar]) {
	await a`insert into media (id, user_id, kind, mime, size, width, height, alt_text, created_at) values (${id}::bigint, ${alice}::bigint, 'photo', 'image/png', ${PNG.length}, 1, 1, ${id === photo ? "a dot" : null}, ${new Date(past(30))})`;
	if (aMedia) {
		mkdirSync(aMedia, { recursive: true });
		writeFileSync(join(aMedia, id), PNG);
	}
}
await a`update users set avatar_url = ${`/media/${avatar}`} where id = ${alice}::bigint`;
const bobPost = idAt(past(20));
await a`insert into posts (id, user_id, text, conversation_id, created_at) values (${bobPost}::bigint, ${bob}::bigint, 'bob says hi', ${bobPost}::bigint, ${new Date(past(20))})`;
const p1 = idAt(past(10)), p2 = idAt(past(9)), p3 = idAt(past(8)), p4 = idAt(past(7)), p5 = idAt(past(6)), poll = idAt(past(6));
await a`insert into posts (id, user_id, text, conversation_id, created_at, edit_count, edited_at) values (${p1}::bigint, ${alice}::bigint, ${`first post @bob_${tag}`}, ${p1}::bigint, ${new Date(past(10))}, 1, ${new Date(past(10) + 60_000)})`;
await a`insert into post_versions (version_id, post_id, seq, text, created_at) values (${idAt(past(10))}::bigint, ${p1}::bigint, 0, 'frist post', ${new Date(past(10))})`;
await a`insert into posts (id, user_id, text, reply_to_id, reply_to_user_id, conversation_id, created_at) values (${p2}::bigint, ${alice}::bigint, 'replying to myself', ${p1}::bigint, ${alice}::bigint, ${p1}::bigint, ${new Date(past(9))})`;
await a`insert into posts (id, user_id, text, quote_id, conversation_id, created_at) values (${p3}::bigint, ${alice}::bigint, 'quoting bob', ${bobPost}::bigint, ${p3}::bigint, ${new Date(past(8))})`;
await a`insert into posts (id, user_id, text, reply_to_id, reply_to_user_id, conversation_id, created_at) values (${p4}::bigint, ${alice}::bigint, 'with a picture', ${bobPost}::bigint, ${bob}::bigint, ${bobPost}::bigint, ${new Date(past(7))})`;
await a`update media set post_id = ${p4}::bigint, position = 0 where id = ${photo}::bigint`;
await a`insert into polls (id, user_id, choices, duration_minutes, ends_at, created_at) values (${poll}::bigint, ${alice}::bigint, ARRAY['tea', 'coffee'], 60, ${new Date(past(6) + 3600_000)}, ${new Date(past(6))})`;
await a`insert into posts (id, user_id, text, conversation_id, poll_id, created_at) values (${p5}::bigint, ${alice}::bigint, 'vote', ${p5}::bigint, ${poll}::bigint, ${new Date(past(6))})`;
await a`update users set pinned_post_id = ${p1}::bigint where id = ${alice}::bigint`;
await a`insert into follows (follower_id, followee_id) values (${alice}::bigint, ${bob}::bigint), (${bob}::bigint, ${alice}::bigint)`;
await a`insert into blocks (blocker_id, blocked_id) values (${alice}::bigint, ${carol}::bigint)`;
await a`insert into likes (user_id, post_id) values (${alice}::bigint, ${bobPost}::bigint)`;
await a`insert into bookmarks (user_id, post_id) values (${alice}::bigint, ${p3}::bigint)`;
await a`insert into muted_keywords (id, user_id, keyword, surfaces) values (${idAt(past(5))}::bigint, ${alice}::bigint, 'spoilers', ARRAY['home_timeline'])`;
const list = idAt(past(5));
await a`insert into lists (id, owner_id, name, description) values (${list}::bigint, ${alice}::bigint, 'friends', 'people')`;
await a`insert into list_members (list_id, user_id) values (${list}::bigint, ${bob}::bigint)`;
await a`insert into scheduled_posts (id, user_id, kind, request) values (${idAt(past(4))}::bigint, ${alice}::bigint, 'draft', ${JSON.stringify({ status: "a draft", media_ids: [photo] })}::text::jsonb)`;
await a`insert into scheduled_posts (id, user_id, kind, execute_at, request) values (${idAt(past(4))}::bigint, ${alice}::bigint, 'scheduled', now() + interval '3 days', ${JSON.stringify({ status: "later" })}::text::jsonb)`;

// --- seed B: the account alice moves into, and B's own copy of bob and his
// post as federation would have made them
const alice2 = await user(b, `alice2_${tag}`);
const bobCopy = await user(b, `bob_${tag}@${A_ID}`, { instance: A_ID, remote_id: bob, password_hash: "!" });
const bobPostCopy = idAt(past(20));
await b`insert into posts (id, user_id, text, conversation_id, created_at) values (${bobPostCopy}::bigint, ${bobCopy}::bigint, 'bob says hi', ${bobPostCopy}::bigint, ${new Date(past(20))})`;
await b`insert into federated_objects (instance, kind, remote_id, local_id) values (${A_ID}, 'post', ${bobPost}::bigint, ${bobPostCopy}::bigint)`;

const sa = await signIn(A, `alice_${tag}`);
const sb = await signIn(B, `alice2_${tag}`);
let failed = 0;
const step = async (name: string, f: () => Promise<void>) => {
	try {
		await f();
		console.log(`ok   ${name}`);
	} catch (e) {
		failed++;
		console.log(`FAIL ${name}\n     ${e instanceof Error ? e.message : e}`);
	}
};

try {
	let code = "";
	await step("A makes a code only with the right password", async () => {
		const wrong = await form(A, sa, { action: "code", password: "nope" });
		assert.equal(wrong.status, 400);
		assert(!/xmig_[A-Za-z0-9_-]{43}/.test(wrong.html));
		code = await newCode(sa);
	});
	await step("the migration API refuses a wrong code", async () => {
		const r = await fetch(`${A}/migration/v1/info`, { headers: { authorization: `Bearer xmig_${"x".repeat(43)}` } });
		assert.equal(r.status, 401);
	});
	await step("B refuses a garbled code and this instance's own address", async () => {
		assert.match((await form(B, sb, { action: "check", source: A_FROM_B, code: "nope" })).html, /isn&#39;t a migration code|isn't a migration code/);
		assert.match((await form(B, sb, { action: "check", source: B_ORIGIN, code })).html, /That&#39;s this instance|That's this instance/);
	});
	let check = "";
	await step("B checks A: versions shown, followers note, no blockers", async () => {
		const r = await form(B, sb, { action: "check", source: A_FROM_B, code });
		assert.equal(r.status, 200, r.html.slice(0, 500));
		check = r.html;
		assert.match(check, /Archive format/);
		assert.match(check, /followers can/);
		assert(!/can&#39;t go ahead|can't go ahead/.test(check), "no blockers");
		assert(field(check, "ack"), "the start form is offered");
	});
	await step("a version mismatch is a warning that needs confirming", async () => {
		const [va, vb] = await Promise.all([A, B].map(async (u) => (await (await fetch(`${u}/.well-known/xitter`)).json()).version));
		if (va === vb) assert(!/Version mismatch/.test(check), "no warning between equal versions");
		else {
			assert(check.includes("Version mismatch") && check.includes(`runs Xitter ${va}, this instance runs ${vb}`), "the warning names both versions");
			assert.match(check, /name="accept"/);
		}
	});
	await step("instances that don't federate get a warning", async () => {
		const federating = (await (await fetch(`${A}/.well-known/xitter`)).json()).federation?.enabled && (await (await fetch(`${B}/.well-known/xitter`)).json()).federation?.enabled;
		if (!federating) {
			assert(check.includes("The two instances don&#39;t federate") || check.includes("The two instances don't federate"), "the warning is shown");
			assert.match(check, /name="accept"/);
		}
	});
	await step("the move runs and finishes", async () => {
		const warned = /Check these before you continue/.test(check);
		const r = await form(B, sb, {
			action: "start", source: field(check, "source")!, code, ack: field(check, "ack")!,
			profile: "1", content: "1", connections: "1", finish: "1", note: "1", ...(warned ? { accept: "1" } : {}),
		});
		assert.equal(r.status, 303, r.html.slice(0, 800));
		const job = await waitForJob(alice2);
		assert.equal(job.state, "done", job.error ?? "");
		assert.equal(job.report.finished?.ok, true, JSON.stringify(job.report.finished));
	});
	await step("posts keep their time, threads, quotes, edits, media and poll", async () => {
		const posts = await b`select id::text, text, reply_to_id::text, conversation_id::text, quote_id::text, poll_id::text, created_at, edit_count from posts where user_id = ${alice2}::bigint order by id`;
		assert.equal(posts.length, 5);
		const by = (t: string) => posts.find((p: any) => p.text.startsWith(t))!;
		const first = by("first post"), reply = by("replying"), quote = by("quoting"), picture = by("with a picture"), vote = by("vote");
		assert.equal(reply.reply_to_id, first.id);
		assert.equal(reply.conversation_id, first.id);
		assert.equal(quote.quote_id, bobPostCopy, "the quote points at B's copy of bob's post");
		assert.equal(picture.reply_to_id, bobPostCopy, "a reply to bob is a reply to B's copy");
		assert(Math.abs(new Date(first.created_at).getTime() - past(10)) < day / 2, "created_at kept");
		assert(BigInt(first.id) < BigInt(reply.id), "ids sort by original time");
		assert.equal(first.edit_count, 1);
		assert.equal(await n(b`select count(*) as n from post_versions where post_id = ${first.id}::bigint`), 1);
		const media = await one(b`select id::text, post_id::text, alt_text, mime from media where post_id = ${picture.id}::bigint`);
		assert(media, "the picture is attached");
		assert.equal(media.alt_text, "a dot");
		if (bMedia && existsSync(bMedia)) assert(existsSync(join(bMedia, media.id)), "the file was copied");
		assert(vote.poll_id, "the poll came along");
		const [mention] = await b`select 1 from post_mentions where post_id = ${first.id}::bigint`;
		assert(mention, "the mention of bob points at B's copy of bob");
	});
	await step("profile, avatar and pinned post", async () => {
		const u = await one(b`select bio, pronouns, location, website, avatar_url, pinned_post_id::text, (select text from posts where id = pinned_post_id) as pinned from users where id = ${alice2}::bigint`);
		assert.equal(u.bio, "hello from A");
		assert.equal(u.location, "Lisbon");
		assert.equal(u.pronouns, "she/her");
		assert.equal(u.website, "https://example.org");
		assert.match(u.avatar_url, /^\/media\/\d+$/);
		assert.match(u.pinned, /^first post/);
	});
	await step("follows, likes, bookmarks, lists, muted words, drafts", async () => {
		assert.equal(await n(b`select count(*) as n from follows where follower_id = ${alice2}::bigint and followee_id = ${bobCopy}::bigint`), 1);
		assert.equal(await n(b`select count(*) as n from likes where user_id = ${alice2}::bigint and post_id = ${bobPostCopy}::bigint`), 1);
		assert.equal(await n(b`select count(*) as n from bookmarks k join posts p on p.id = k.post_id where k.user_id = ${alice2}::bigint and p.text = 'quoting bob'`), 1);
		assert.equal(await n(b`select count(*) as n from lists l join list_members m on m.list_id = l.id where l.owner_id = ${alice2}::bigint and m.user_id = ${bobCopy}::bigint`), 1);
		assert.equal(await n(b`select count(*) as n from muted_keywords where user_id = ${alice2}::bigint and keyword = 'spoilers'`), 1);
		const draft = await one(b`select request from scheduled_posts where user_id = ${alice2}::bigint and kind = 'draft'`);
		const [m] = draft.request.media_ids;
		assert(m && m !== photo, "the draft's upload points at B's copy");
		assert.equal(await n(b`select count(*) as n from media where id = ${m}::bigint and user_id = ${alice2}::bigint`), 1);
		assert.equal(await n(b`select count(*) as n from scheduled_posts where user_id = ${alice2}::bigint and kind = 'scheduled'`), 1);
	});
	await step("carol isn't known on B, so the block is reported, not guessed", async () => {
		const job = await waitForJob(alice2);
		assert(job.report.unresolved.some((u: string) => u.startsWith(`@carol_${tag}`)), JSON.stringify(job.report.unresolved));
	});
	await step("A recorded the move, left the note and cancelled the scheduled post", async () => {
		const u = await one(a`select moved_to, bio, status from users where id = ${alice}::bigint`);
		const to = `alice2_${tag}@${host(B_ORIGIN)}`.toLowerCase();
		assert.equal(u.moved_to, to);
		assert.equal(u.bio, `Moved to @${to}`);
		assert.equal(u.status, "active", "not deactivated unless asked");
		assert.equal(await n(a`select count(*) as n from scheduled_posts where user_id = ${alice}::bigint and kind = 'scheduled'`), 0);
		const r = await fetch(`${A}/migration/v1/info`, { headers: { authorization: `Bearer ${code}` } });
		assert.equal(r.status, 401, "the finished code doesn't work any more");
	});
	await step("a second run with a new code adds nothing", async () => {
		await a`update users set bio = 'hello from A' where id = ${alice}::bigint`;
		const again = await newCode(sa);
		const r = await form(B, sb, { action: "check", source: A_FROM_B, code: again });
		assert.match(r.html, /already brought over/);
		const started = await form(B, sb, { action: "start", source: field(r.html, "source")!, code: again, ack: field(r.html, "ack")!, profile: "1", content: "1", connections: "1", ...(/Check these/.test(r.html) ? { accept: "1" } : {}) });
		assert.equal(started.status, 303, started.html.slice(0, 500));
		const job = await waitForJob(alice2);
		assert.equal(job.state, "done", job.error ?? "");
		assert.equal(await n(b`select count(*) as n from posts where user_id = ${alice2}::bigint`), 5);
		assert.equal(await n(b`select count(*) as n from media where user_id = ${alice2}::bigint`), 2);
		assert.equal(await n(b`select count(*) as n from lists where owner_id = ${alice2}::bigint`), 1);
		await revoke(sa);
	});
	await step("with warnings, start is refused until they're accepted", async () => {
		// a fresh account on B with a post of its own triggers the not-empty warning
		const other = await user(b, `dest_${tag}`);
		await b`insert into posts (id, user_id, text, conversation_id) values (${idAt(Date.now())}::bigint, ${other}::bigint, 'already here', ${idAt(Date.now())}::bigint)`;
		const so = await signIn(B, `dest_${tag}`);
		const c = await newCode(sa);
		const r = await form(B, so, { action: "check", source: A_FROM_B, code: c });
		assert.match(r.html, /Check these before you continue/);
		assert.match(r.html, /already has 1 posts/);
		const refused = await form(B, so, { action: "start", source: field(r.html, "source")!, code: c, ack: field(r.html, "ack")!, content: "1" });
		assert.equal(refused.status, 400);
		assert.match(refused.html, /Tick the box/);
		assert.equal(await n(b`select count(*) as n from account_migrations where user_id = ${other}::bigint`), 0);
		await revoke(sa);
	});
	await step("a restricted account can't move posts in", async () => {
		const limited = await user(b, `restr_${tag}`);
		const sr = await signIn(B, `restr_${tag}`);
		await b`update users set status = 'restricted' where id = ${limited}::bigint`;
		const c = await newCode(sa);
		const r = await form(B, sr, { action: "check", source: A_FROM_B, code: c });
		assert.match(r.html, /can&#39;t post right now|can't post right now/);
		const refused = await form(B, sr, { action: "start", source: A_FROM_B, code: c, ack: field(r.html, "ack") ?? "", content: "1", accept: "1" });
		assert.equal(refused.status, 400);
		assert.equal(await n(b`select count(*) as n from account_migrations where user_id = ${limited}::bigint`), 0);
		await revoke(sa);
	});
} finally {
	await a`delete from users where id in (${alice}::bigint, ${bob}::bigint, ${carol}::bigint)`;
	await b`delete from users where screen_name like ${`%${tag}%`}`;
	await a.close();
	await b.close();
}
async function revoke(s: Session) {
	await form(A, s, { action: "revoke" });
}
if (failed) {
	console.log(`${failed} failed`);
	process.exit(1);
}
console.log("all migration checks passed");
