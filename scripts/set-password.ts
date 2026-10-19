// Sets an account's password. The password is read from stdin (piped, or typed
// into a prompt) so it never appears in a shell history, a process list or a
// chat transcript.
//
//   printf '%s' "$PW" | docker compose exec -T app bun scripts/set-password.ts gab
//   docker compose exec -it app bun scripts/set-password.ts gab

import { migrate, sql } from "../src/db";

const [screenName] = process.argv.slice(2);
if (!screenName) {
	console.error("usage: bun scripts/set-password.ts <screen_name>");
	process.exit(1);
}

await migrate();
const [u] = await sql`select id from users where lower(screen_name) = lower(${screenName})`;
if (!u) {
	console.error(`no account @${screenName}`);
	await sql.close();
	process.exit(1);
}

const password = (await new Response(Bun.stdin.stream()).text()).replace(/\r?\n$/, "");

if (password.length < 8) {
	console.error(`passwords are at least 8 characters (got ${password.length})`);
	await sql.close();
	process.exit(1);
}
if (password.length > 256) {
	console.error("passwords are at most 256 characters");
	await sql.close();
	process.exit(1);
}

// same hashing the sign-in path verifies against (src/auth.ts)
await sql`update users set password_hash = ${await Bun.password.hash(password)} where id = ${u.id}::bigint`;
console.log(`@${screenName} password updated`);
await sql.close();