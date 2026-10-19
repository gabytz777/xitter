// Recovery proof expiry is checked at consumption, after waiting for account locks.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { SQL } from "bun";
import { sql } from "../src/db";
import { newId } from "../src/ids";
import { resetRoute } from "../src/password-reset";
import { emailRoute } from "../src/email-address";
import { answerChallenge } from "../src/two-factor";
import { codeAt, newSecret } from "../src/totp";
const database = new URL(process.env.DATABASE_URL ?? "postgres://localhost/xitter");
assert(["localhost", "127.0.0.1"].includes(database.hostname) && /test|codex/.test(database.pathname), "Use a disposable local test database.");
const control = new SQL(database.href, { max: 2 });
const fixtures: string[] = [];
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const passwordHash = await Bun.password.hash("original123");
async function fixture() {
 const id = newId(); fixtures.push(id);
 await sql`insert into users(id,screen_name,name,password_hash,email,email_verified) values (${id}::bigint,${`expiry_${id}`},'Expiry fixture',${passwordHash},${`${id}@example.test`},true)`;
 return id;
}
async function afterLock<T>(id: string, run: () => Promise<T>, expire: (tx: SQL) => Promise<unknown>): Promise<T> {
 const locked = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); let pid = 0;
 const holder = control.begin(async tx => {
  await tx`select id from users where id=${id}::bigint for update`;
  pid = (await tx`select pg_backend_pid() as pid`)[0].pid; locked.resolve();
  await release.promise; await expire(tx);
 });
 await locked.promise; const operation = run(); void operation.catch(() => undefined);
 try {
  const deadline = Date.now()+10_000;
  for (;;) {
   const rows = await control`select 1 from pg_stat_activity where ${pid}::int = any(pg_blocking_pids(pid))`;
   if (rows.length) break;
   assert(Date.now()<deadline,"operation must actually wait for its account lock"); await Bun.sleep(10);
  }
  release.resolve(); await holder; return await operation;
 } finally { release.resolve(); await holder; await operation.catch(() => undefined); }
}
try {
 const reset = await fixture(), token = randomBytes(32).toString("hex");
 await sql`insert into password_resets(token_hash,user_id) values (${hash(token)},${reset}::bigint)`;
 const url = new URL("http://localhost/account/reset");
 const response = await afterLock(reset, () => resetRoute(new Request(url,{method:"POST",body:new URLSearchParams({token,password:"changed123",confirm:"changed123"})}),url),
  tx => tx`update password_resets set created_at=clock_timestamp()-interval '1 hour' where token_hash=${hash(token)}`);
 assert.equal(response.status,410,"a reset link expiring during the users lock wait must not change the password");
 assert.equal((await sql`select password_hash from users where id=${reset}::bigint`)[0].password_hash,passwordHash);
 assert.equal((await sql`select used from password_resets where token_hash=${hash(token)}`)[0].used,false);
 console.log("ok: password reset rechecks actual expiry after acquiring the account lock");
 const email = await fixture(), emailToken = randomBytes(32).toString("hex");
 await sql`insert into email_confirmations(token_hash,user_id,email) values (${hash(emailToken)},${email}::bigint,${`new_${email}@example.test`})`;
 const emailUrl = new URL(`http://localhost/account/email/confirm?token=${emailToken}`);
 const emailResponse = await afterLock(email,()=>emailRoute(new Request(emailUrl),emailUrl,undefined),
  tx => tx`update email_confirmations set created_at=clock_timestamp()-interval '1 day' where token_hash=${hash(emailToken)}`);
 assert.equal(emailResponse.status,410,"an expired confirmation cannot replace the recovery address");
 assert.equal((await sql`select email from users where id=${email}::bigint`)[0].email,`${email}@example.test`);
 assert.equal((await sql`select used from email_confirmations where token_hash=${hash(emailToken)}`)[0].used,false);
 console.log("ok: email confirmation rechecks actual expiry after acquiring the account lock");
 const totp = await fixture(), challenge = crypto.randomUUID(), secret = newSecret();
 await sql`update users set totp_enabled=true,totp_secret=${secret} where id=${totp}::bigint`;
 await sql`insert into login_challenges(token,user_id) values (${challenge}::uuid,${totp}::bigint)`;
 const answer = await afterLock(totp,()=>answerChallenge(challenge,codeAt(secret,Math.floor(Date.now()/30_000))),
  tx => tx`update login_challenges set created_at=clock_timestamp()-interval '15 minutes' where token=${challenge}::uuid`);
 assert.equal(answer.unknown,true,"an expired challenge cannot mint a session");
 assert.equal((await sql`select count(*)::int n from sessions where user_id=${totp}::bigint`)[0].n,0);
 console.log("ok: a valid TOTP cannot revive a challenge that expired while waiting for the account lock");
} finally { for(const id of fixtures)await sql`delete from users where id=${id}::bigint`;await sql.close();await control.close(); }
