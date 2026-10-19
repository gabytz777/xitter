// Actual application HTTP + PostgreSQL list privacy races. No external calls.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const database = new URL(process.env.DATABASE_URL ?? "postgres://localhost/xitter");
assert(["localhost", "127.0.0.1"].includes(database.hostname) && /test|codex/.test(database.pathname), "Use a disposable local test database.");
const dir = await mkdtemp(join(tmpdir(), "xitter-list-visibility-")); process.env.MEDIA_DIR = dir;
const { sql, migrate } = await import("../src/db");
const { createUser, startSession, sessionCookies } = await import("../src/auth");
await migrate();
const fixtureIds: string[] = [];
async function fixture() {
	const name = `ls${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`;
	const id = await createUser(name, "List privacy fixture", "original123"); fixtureIds.push(id);
	const s = await startSession(id);
	return { id, name, headers: { cookie: sessionCookies(s).map((c) => c.split(";")[0]).join("; "), "x-csrf-token": s.csrf, "content-type": "application/json" } };
}
const owner = await fixture(), visitor = await fixture();
const probe = Bun.serve({ port: 0, fetch: () => new Response() }); const port = probe.port; probe.stop(true);
const origin = `http://localhost:${port}`;
const env = { ...process.env, DATABASE_URL: database.href, PORT: String(port), PUBLIC_ORIGIN: origin, MEDIA_DIR: dir, RATE_LIMITS: "off" };
const server = Bun.spawn([process.execPath, "src/server.ts"], { cwd: join(import.meta.dir, ".."), env, stdout: "ignore", stderr: "pipe" });
const diagnostics = new Response(server.stderr).text();
const call = (v: typeof owner, op: string, variables: object = {}) => fetch(`${origin}/i/api/graphql/q/${op}`, { method: "POST", headers: v.headers, body: JSON.stringify({ variables }) });
const result = async (v: typeof owner, op: string, variables: object = {}) => (await call(v, op, variables)).json();
async function waitFor(check: () => Promise<boolean>, description: string) {
	const deadline = Date.now() + 10_000;
	while (!(await check())) { assert(Date.now() < deadline, description); await Bun.sleep(10); }
}
async function createList() {
	const out = await result(owner, "CreateList", { name: "Public list", description: "Public description", isPrivate: false });
	assert(out.data?.list?.id_str); return out.data.list.id_str as string;
}
async function hiddenOnAllSurfaces(id: string, marker: string) {
	assert((await result(visitor, "ListByRestId", { listId: id })).errors?.length);
	for (const op of ["ListsManagementPageTimeline", "PinnableTimelines", "PinnedTimelines"]) {
		const text = await (await call(visitor, op)).text();
		assert(!text.includes(marker), `${op} exposed inaccessible list metadata`);
	}
}
try {
	const deadline = Date.now() + 15_000;
	while (true) { try { if ((await fetch(`${origin}/api/v1/me`)).status === 401) break; } catch {} assert(Date.now() < deadline, "Server did not start"); await Bun.sleep(20); }
	for (const first of ["subscribe", "private"]) {
		const id = await createList(), fn = `test_list_race_${id}`, lock = Number(BigInt(id) % 2147483647n) + 1;
		const held = await sql.reserve(); let a: Promise<Response> | undefined, b: Promise<Response> | undefined;
		const marker = `PRIVATE_${id}`;
		try {
			const table = first === "subscribe" ? "list_subscribers" : "lists";
			const condition = first === "subscribe" ? `NEW.list_id=${id} and NEW.user_id=${visitor.id}` : `NEW.id=${id} and NEW.is_private`;
			await sql.unsafe(`create function ${fn}() returns trigger language plpgsql as $$ begin if ${condition} then perform pg_advisory_xact_lock(${lock}); end if; return NEW; end $$`);
			await sql.unsafe(`create trigger ${fn} before ${first === "subscribe" ? "insert" : "update"} on ${table} for each row execute function ${fn}()`);
			await held`select pg_advisory_lock(${lock})`;
			const subscribe = () => call(visitor, "ListSubscribe", { listId: id });
			const privatize = () => call(owner, "UpdateList", { listId: id, name: "Private list", description: marker, isPrivate: true });
			a = first === "subscribe" ? subscribe() : privatize();
			await waitFor(async () => (await sql`select 1 from pg_locks where locktype='advisory' and objid=${lock}::oid and not granted`).length > 0, "First mutation did not reach barrier");
			b = first === "subscribe" ? privatize() : subscribe();
			await waitFor(async () => (await sql`select 1 from pg_stat_activity where datname=current_database() and wait_event='transactionid' and query like '%from lists l%for update%'`).length > 0, "Second mutation did not serialize on list row");
			await held`select pg_advisory_unlock(${lock})`;
			const [left, right] = await Promise.all([a, b]);
			const ownResponse = await (first === "subscribe" ? right : left).json(); assert.equal(ownResponse.data?.list?.mode, "Private");
			assert.equal(Number((await sql`select count(*) as n from list_subscribers where list_id=${id}::bigint and user_id=${visitor.id}::bigint`)[0].n), 0);
			await hiddenOnAllSurfaces(id, marker);
			assert.equal((await result(owner, "ListByRestId", { listId: id })).data.list.description, marker);
		} finally {
			await held`select pg_advisory_unlock(${lock})`; held.release();
			await a?.catch(() => undefined); await b?.catch(() => undefined);
			await sql.unsafe(`drop trigger if exists ${fn} on ${first === "subscribe" ? "list_subscribers" : "lists"}`); await sql.unsafe(`drop function if exists ${fn}()`);
		}
	}
	console.log("ok: both subscription/privacy lock orderings leave no stale subscriber or private metadata leak");
	const stale = await createList(), marker = `PRIVATE_STALE_${stale}`;
	assert(!(await result(owner, "UpdateList", { listId: stale, description: marker, isPrivate: true })).errors);
	await sql`insert into list_subscribers(list_id,user_id) values(${stale}::bigint,${visitor.id}::bigint)`;
	await sql`insert into pinned_lists(user_id,list_id,position) values(${visitor.id}::bigint,${stale}::bigint,0)`;
	await hiddenOnAllSurfaces(stale, marker);
	assert((await (await call(owner, "ListsManagementPageTimeline")).text()).includes(marker));
	const blocked = await createList(), blockedMarker = `BLOCKED_${blocked}`;
	assert(!(await result(visitor, "ListSubscribe", { listId: blocked })).errors);
	assert(!(await result(owner, "UpdateList", { listId: blocked, description: blockedMarker })).errors);
	for (const [a, b] of [[owner.id, visitor.id], [visitor.id, owner.id]]) {
		await sql`insert into blocks(blocker_id,blocked_id) values(${a}::bigint,${b}::bigint)`;
		await hiddenOnAllSurfaces(blocked, blockedMarker);
		await sql`delete from blocks where blocker_id=${a}::bigint and blocked_id=${b}::bigint`;
	}
	console.log("ok: seeded stale subscriptions/pins cannot bypass current privacy or either block direction");
	// A failed cleanup must roll back the visibility update as well.
	const rollback = await createList(), fn = `test_list_rollback_${rollback}`;
	assert(!(await result(visitor, "ListSubscribe", { listId: rollback })).errors);
	try {
		await sql.unsafe(`create function ${fn}() returns trigger language plpgsql as $$ begin if OLD.list_id=${rollback} then raise exception 'fixture list cleanup failure'; end if; return OLD; end $$`);
		await sql.unsafe(`create trigger ${fn} before delete on list_subscribers for each row execute function ${fn}()`);
		assert.equal((await call(owner, "UpdateList", { listId: rollback, isPrivate: true })).status, 500);
		assert.equal((await sql`select is_private from lists where id=${rollback}::bigint`)[0].is_private, false);
		assert.equal(Number((await sql`select count(*) as n from list_subscribers where list_id=${rollback}::bigint`)[0].n), 1);
	} finally { await sql.unsafe(`drop trigger if exists ${fn} on list_subscribers`); await sql.unsafe(`drop function if exists ${fn}()`); }
	console.log("ok: failed subscriber cleanup rolls back the private transition");
	await sql`update users set role='admin' where id=${owner.id}::bigint`;
	const legacy = Bun.spawn([process.execPath, "scripts/test-lists.ts", owner.name, visitor.name, "original123"], { cwd: join(import.meta.dir, ".."), env, stdout: "pipe", stderr: "pipe" });
	const output = await new Response(legacy.stdout).text(), errors = await new Response(legacy.stderr).text();
	assert.equal(await legacy.exited, 0, `${output}\n${errors}`);
	console.log("ok: existing actual-server list create/member/timeline/subscribe/privacy/pinning/delete suite passes");
} finally {
	server.kill(); await server.exited; await diagnostics;
	for (const id of fixtureIds) await sql`delete from users where id=${id}::bigint`;
	await sql.close(); await rm(dir, { recursive: true, force: true });
}
