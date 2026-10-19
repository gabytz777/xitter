// Real PostgreSQL issuance races; mail transport is intercepted, never sent.
// DATABASE_URL=postgres://localhost/xitter_test bun scripts/test-password-reset-issuance.ts
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

process.env.RESEND_API_KEY = "test-no-network";
const nativeFetch = globalThis.fetch;
const sent: { to: string[] }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
	assert.equal(String(input), "https://api.resend.com/emails", "Unexpected network call in isolated mail regression");
	sent.push(JSON.parse(String(init?.body)));
	return Response.json({ id: "test-mail" });
}) as typeof fetch;
const { sql } = await import("../src/db");
const database = new URL(process.env.DATABASE_URL ?? "postgres://localhost/xitter");
assert(["localhost", "127.0.0.1"].includes(database.hostname) && /test|codex/.test(database.pathname), "Use a disposable local test database.");
const { createUser } = await import("../src/auth");
const { requestReset } = await import("../src/password-reset");
const name = `r${randomBytes(6).toString("hex")}`;
const id = await createUser(name, "Reset issuance test", "original123");
const oldEmail = `old-${id}@example.test`, newEmail = `new-${id}@example.test`;
await sql`update users set email = ${oldEmail} where id = ${id}::bigint`;
let release: (() => void) | undefined;
let holder: Promise<unknown> | undefined;
let request: Promise<void> | undefined;
try {
	const locked = Promise.withResolvers<void>();
	const resume = Promise.withResolvers<void>();
	release = () => resume.resolve();
	holder = sql.begin(async (tx) => {
		await tx`select id from users where id = ${id}::bigint for update`;
		locked.resolve();
		await resume.promise;
		await tx`update users set email = ${newEmail}, email_verified = true where id = ${id}::bigint`;
		await tx`update password_resets set used = true where user_id = ${id}::bigint and not used`;
	});
	await locked.promise;
	request = requestReset(oldEmail);
	const deadline = Date.now() + 10_000;
	while (!(await sql`select 1 from pg_stat_activity where datname = current_database() and wait_event = 'transactionid' and query like '%select id::text, screen_name, email from users%for update%'`).length) {
		assert(Date.now() < deadline, "Issuance did not wait on the account lock");
		await Bun.sleep(10);
	}
	release();
	await holder;
	await request;
	assert.equal(sent.length, 0, "an old email address received a new recovery token");
	assert.equal((await sql`select 1 from password_resets where user_id = ${id}::bigint`).length, 0);
	console.log("ok: issuance waiting across an email change cannot issue a recovery token to the old address");
	await Promise.all(Array.from({ length: 12 }, () => requestReset(name)));
	assert.equal((await sql`select 1 from password_resets where user_id = ${id}::bigint and not used`).length, 1);
	assert.equal(sent.length, 1);
	assert.deepEqual(sent[0].to, [newEmail]);
	console.log("ok: simultaneous reset requests produce one link and one mail to the current address");
} finally {
	release?.();
	await holder?.catch(() => undefined);
	await request?.catch(() => undefined);
	globalThis.fetch = nativeFetch;
	await sql`delete from mail_log where user_id = ${id}::bigint`;
	await sql`delete from users where id = ${id}::bigint`;
	await sql.close();
}
