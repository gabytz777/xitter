// Real Postgres checks for one-use recovery codes and login challenges.
// DATABASE_URL=postgres://localhost/xitter_test RATE_LIMITS=off bun scripts/test-two-factor-concurrency.ts
import { strict as assert } from "node:assert";
import { createHash, randomBytes } from "node:crypto";
import { createUser } from "../src/auth";
import { sql } from "../src/db";
import { codeAccepted, answerChallenge } from "../src/two-factor";
import { codeAt, newSecret, verifyCode } from "../src/totp";

const id = await createUser(`t${randomBytes(6).toString("hex")}`, "Two-factor concurrency test", "testpass123");
let secret = newSecret();
while (["123456", "654321"].some((code) => verifyCode(secret, code))) secret = newSecret();
const backup = createHash("sha256").update("123456").digest("hex");
const challenge = async () => {
	const token = crypto.randomUUID();
	await sql`insert into login_challenges (token, user_id) values (${token}::uuid, ${id}::bigint)`;
	return token;
};
try {
	for (const invalid of ["", "-".repeat(36), "a".repeat(36), "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa--"])
		assert.deepEqual(await answerChallenge(invalid, "123456"), { unknown: true });
	console.log("ok: malformed challenge tokens fail without a database error");
	await sql`update users set totp_enabled = true, totp_secret = ${secret}, totp_backup = ${JSON.stringify([backup])}::text::jsonb where id = ${id}::bigint`;
	assert.equal(await codeAccepted(id, "wrong"), false);
	const accepted = await Promise.all(Array.from({ length: 12 }, () => codeAccepted(id, "123456")));
	assert.equal(accepted.filter(Boolean).length, 1, "a recovery code works exactly once across simultaneous requests");
	assert.equal(await codeAccepted(id, "123456"), false);
	console.log("ok: a recovery code is consumed exactly once, including concurrent requests");
	const secondBackup = createHash("sha256").update("654321").digest("hex");
	await sql`update users set totp_backup = ${JSON.stringify([backup, secondBackup])}::text::jsonb where id = ${id}::bigint`;
	const distinct = await Promise.all(Array.from({ length: 12 }, (_, i) => codeAccepted(id, i % 2 ? "123456" : "654321")));
	assert.equal(distinct.filter(Boolean).length, 2);
	assert.deepEqual((await sql`select totp_backup from users where id = ${id}::bigint`)[0].totp_backup, []);
	console.log("ok: consuming different recovery codes concurrently cannot restore a spent code");
	const token = await challenge();
	const code = codeAt(secret, Math.floor(Date.now() / 30_000));
	const answers = await Promise.all(Array.from({ length: 8 }, () => answerChallenge(token, code)));
	assert.equal(answers.filter((a) => a.userId === id).length, 1, "a sign-in challenge completes exactly once");
	assert((await answerChallenge(token, code)).unknown);
	console.log("ok: a login challenge cannot create multiple successful sign-ins");
	const wrong = await challenge();
	const guesses = await Promise.all(Array.from({ length: 12 }, () => answerChallenge(wrong, "wrong")));
	assert(guesses.every((a) => !a.userId));
	const [row] = await sql`select attempts from login_challenges where token = ${wrong}::uuid`;
	assert(!row || row.attempts <= 5, "the five-attempt limit holds under concurrency");
	assert(!(await answerChallenge(wrong, code)).userId);
	console.log("ok: concurrent wrong guesses cannot overrun the five-attempt limit");
} finally {
	await sql`delete from users where id = ${id}::bigint`;
	await sql.close();
}
