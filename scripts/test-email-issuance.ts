// Real PostgreSQL issuance races. All mail is intercepted locally, never sent.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
process.env.RESEND_API_KEY = "test-no-network";
const nativeFetch = globalThis.fetch;
const nativeVerify = Bun.password.verify;
const sent: { to: string[]; text: string }[] = [];
globalThis.fetch = (async (input, init) => {
 assert.equal(String(input), "https://api.resend.com/emails", "Unexpected network call");
 sent.push(JSON.parse(String(init?.body)));
 return Response.json({ id: "test-mail" });
}) as typeof fetch;
const { sql } = await import("../src/db");
const { createUser, startSession, viewerById } = await import("../src/auth");
const { emailRoute, resendConfirmation } = await import("../src/email-address");
const { resetRoute } = await import("../src/password-reset");
const database = new URL(process.env.DATABASE_URL ?? "postgres://localhost/xitter");
assert(["localhost", "127.0.0.1"].includes(database.hostname) && /test|codex/.test(database.pathname), "Use a disposable local test database.");
const id = await createUser(`e${randomBytes(6).toString("hex")}`, "Email issuance test", "original123");
const session = await startSession(id);
const viewer = { ...(await viewerById(id)), ...session } as any;
const email = `new-${id}@example.test`;
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const resume = Promise.withResolvers<void>();
let inFlight: Promise<Response> | undefined;
let holder: Promise<unknown> | undefined;
let resend: Promise<string | null> | undefined;
let unlock: (() => void) | undefined;
try {
 const entered = Promise.withResolvers<void>();
 let paused = false;
 Bun.password.verify = async (password, encoded, algorithm) => {
  const ok = await nativeVerify(password, encoded, algorithm);
  if (!paused && password === "original123" && ok) { paused = true; entered.resolve(); await resume.promise; }
  return ok;
 };
 const req = new Request("http://localhost/account/email", { method: "POST", body: new URLSearchParams({ csrf: viewer.csrf, password: "original123", email }) });
 inFlight = emailRoute(req, new URL(req.url), viewer);
 await entered.promise;
 const resetToken = randomBytes(32).toString("hex");
 await sql`insert into password_resets (token_hash, user_id) values (${hash(resetToken)}, ${id}::bigint)`;
 const resetReq = new Request("http://localhost/account/reset", { method: "POST", body: new URLSearchParams({ token: resetToken, password: "recovered123", confirm: "recovered123" }) });
 assert.equal((await resetRoute(resetReq, new URL(resetReq.url))).status, 200);
 resume.resolve();
 assert.equal((await inFlight).status, 400, "stale password proof cannot issue email confirmation after recovery");
 assert.equal(sent.length, 0);
 assert.equal((await sql`select 1 from email_confirmations where user_id = ${id}::bigint`).length, 0);
 Bun.password.verify = nativeVerify;
 console.log("ok: in-flight old password cannot issue a confirmation after password recovery");
 // Seed a pending address old enough to resend, then revoke it while the
 // resend waits behind the same account lock used by credential changes.
 await sql`update users set email = ${`current-${id}@example.test`}, email_verified = true where id = ${id}::bigint`;
 await sql`insert into email_confirmations (token_hash, user_id, email, created_at) values (${hash("pending")}, ${id}::bigint, ${email}, now() - interval '2 minutes')`;
 const locked = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
 unlock = () => release.resolve();
 holder = sql.begin(async (tx) => {
  await tx`select id from users where id = ${id}::bigint for update`;
  locked.resolve(); await release.promise;
  await tx`update email_confirmations set used = true where user_id = ${id}::bigint`;
 });
 await locked.promise;
 resend = resendConfirmation(viewer);
 const deadline = Date.now() + 10_000;
 while (!(await sql`select 1 from pg_stat_activity where datname = current_database() and wait_event = 'transactionid' and query like '%select email, email_verified from users%for update%'`).length) {
  assert(Date.now() < deadline, "Resend did not reach the account lock"); await Bun.sleep(10);
 }
 unlock(); await holder;
 assert.equal(await resend, "There's no address waiting to be confirmed.");
 assert.equal(sent.length, 0, "resend cannot revive a revoked pending address");
 assert.equal((await sql`select 1 from email_confirmations where user_id = ${id}::bigint and not used`).length, 0);
 console.log("ok: resend rechecks pending addresses after credential-change invalidation");
 // Current credentials still issue useful mail; its token is confirmable.
 const freshReq = new Request("http://localhost/account/email", { method: "POST", body: new URLSearchParams({ csrf: viewer.csrf, password: "recovered123", email }) });
 assert.equal((await emailRoute(freshReq, new URL(freshReq.url), viewer)).status, 200);
 assert.equal(sent.length, 1); assert.deepEqual(sent[0].to, [email]);
 const token = /token=([a-f0-9]{64})/.exec(sent[0].text)?.[1]; assert(token);
 const confirmUrl = new URL(`http://localhost/account/email/confirm?token=${token}`);
 assert.equal((await emailRoute(new Request(confirmUrl), confirmUrl, undefined)).status, 200);
 console.log("ok: current password still issues a usable confirmation link");
} finally {
 resume.resolve(); unlock?.();
 await inFlight?.catch(() => undefined); await holder?.catch(() => undefined); await resend?.catch(() => undefined);
 Bun.password.verify = nativeVerify; globalThis.fetch = nativeFetch;
 await sql`delete from mail_log where user_id = ${id}::bigint`;
 await sql`delete from users where id = ${id}::bigint`;
 await sql.close();
}
