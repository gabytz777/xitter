// Creates the account behind the Grok-like assistant (src/grok.ts) if it does
// not exist, and points its "Automated by" label at its owner.
//
//   docker compose exec -T app bun scripts/grok-setup.ts [handle] [owner]
//
// Defaults to GROK_HANDLE (or "grok") and the owner "gab".

import { createUser } from "../src/auth";
import { migrate, sql } from "../src/db";

const [handleArg = process.env.GROK_HANDLE || "grok", ownerArg = "gab"] = process.argv.slice(2);
const wanted = handleArg.replace(/^@/, "").toLowerCase();

await migrate();

let [bot] = await sql`select id::text as id from users where lower(screen_name) = ${wanted}`;
if (bot) {
	console.log(`@${wanted} already exists (${bot.id})`);
} else {
	// a bot never signs in; the password is random and never shown
	const id = await createUser(wanted, "Grok", `${crypto.randomUUID()}${crypto.randomUUID()}`);
	await sql`update users set bio = ${"Ask me anything. I will be confidently wrong."} where id = ${id}::bigint`;
	bot = { id };
	console.log(`created @${wanted} (${id})`);
}

const [owner] = await sql`select id from users where lower(screen_name) = lower(${ownerArg})`;
if (owner) {
	await sql`update users set automated_by = ${owner.id}::bigint where id = ${bot.id}::bigint`;
	console.log(`@${wanted} is now labelled "Automated by @${ownerArg}"`);
} else {
	console.log(`no owner @${ownerArg}; leaving the automated label alone`);
}

await sql.close();
