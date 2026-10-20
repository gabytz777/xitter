// Mints a write-scoped API token for the alerts bot, so the host-side monitor
// (xitter-ops/instance-alerts.sh) can post as the account without ever holding
// the account's password or a staff session.
//
//   docker compose exec -T app bun scripts/alerts-setup.ts [handle]
//
// Prints the token once. It is stored hashed, so it cannot be read back later:
// re-run this to mint a fresh one. Write scope on an API token can post, quote
// and reply as that one account — it cannot pin, edit, delete, read DMs or
// reach any admin route.

import { migrate, sql } from "../src/db";
import { createToken } from "../src/public-api";

const [handleArg = process.env.ALERTS_HANDLE || "OpsexBestSocial"] = process.argv.slice(2);
const wanted = handleArg.replace(/^@/, "").toLowerCase();

await migrate();

const [bot] = await sql`select id::text as id, role from users where lower(screen_name) = ${wanted}`;
if (!bot) {
	console.error(`no @${wanted} account — create it first`);
	await sql.close();
	process.exit(1);
}

// One live token at a time keeps a leaked or lost one from lingering.
const existing = await sql`select id::text as id from api_tokens where user_id = ${bot.id}::bigint and name = 'instance alerts'`;
for (const t of existing) await sql`delete from api_tokens where id = ${t.id}::bigint`;

const token = await createToken(bot.id, "instance alerts", "write");
console.log(`@${wanted} (role ${bot.role ?? "none"}) — write-scoped token:`);
console.log(token);
console.log("");
console.log("Put it in xitter-ops/.alerts-token on the host (mode 600).");

await sql.close();
