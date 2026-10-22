// Shared minting for password-reset links (password-reset.ts and discord.ts)
// so the two modules don't need to import each other to create a token.
import { createHash } from "node:crypto";
import { sql } from "./db";

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

// A link for an account whose identity has already been proven some other way:
// the same one-hour, one-use link the mail would carry.
export async function issueResetToken(userId: string): Promise<string> {
	const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
	await sql`insert into password_resets (token_hash, user_id) values (${hash(token)}, ${userId}::bigint)`;
	return token;
}
