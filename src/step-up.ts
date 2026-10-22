// Confirming with Discord (discord.ts) stands in for typing the password
// again: this instance sends no mail, and an account created by signing in with
// Discord has a password nobody knows. One confirmation grants fifteen minutes
// in which the screens that ask for the password — changing the email, adding a
// passkey, making a migration code — take it either way.
//
// The password is never taken away: an account that has one can always type it.
// The two screens that are *about* the password (changing it, turning the
// account off) stay password-only on purpose, because a Discord sign-up sets one
// first with "Set a password" (discord.ts), which is a reset and needs no old
// password at all.
import { sql } from "./db";

export async function stepUpActive(userId: string): Promise<boolean> {
	const [row] = await sql`select 1 from step_up_grants where user_id = ${userId}::bigint and until > now()`;
	return !!row;
}

// one row per account: confirming again just pushes the end out
export async function grantStepUp(userId: string): Promise<void> {
	await sql`insert into step_up_grants (user_id, until) values (${userId}::bigint, now() + interval '15 minutes')
		on conflict (user_id) do update set until = excluded.until, created_at = now()`;
}

export async function revokeStepUp(userId: string): Promise<void> {
	await sql`delete from step_up_grants where user_id = ${userId}::bigint`;
}

// The one question those screens ask: is this the password, or has this account
// just confirmed with Discord?
export async function passwordOrStepUp(userId: string, typed: string, passwordHash: string | null): Promise<boolean> {
	if (await stepUpActive(userId)) return true;
	if (!passwordHash || !typed || typed.length > 1024) return false;
	return Bun.password.verify(typed, passwordHash).catch(() => false);
}
