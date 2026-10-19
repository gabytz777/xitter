// Outgoing mail through Resend. The key is send-only, so this is the one call we make.
// Every attempt is kept in mail_log (Admin > Settings > Email), including the
// ones skipped for want of a key, so it shows whether mail would have gone out.
import { sql } from "./db";
import { newId } from "./ids";
import { settings } from "./settings";

const KEY = process.env.RESEND_API_KEY;
const FROM_ADDRESS = "noreply@xit.chococat.lol";
// without MAIL_FROM the sender is named after the instance; quoted, as a name may hold commas
export const mailFrom = () => process.env.MAIL_FROM ?? `${JSON.stringify(settings().instance_name)} <${FROM_ADDRESS}>`;

export const mailEnabled = () => !!KEY;

async function log(to: string, kind: string, subject: string, status: "sent" | "failed" | "skipped", error: string | null, userId?: string) {
	await sql`insert into mail_log (id, user_id, to_addr, kind, subject, status, error)
		values (${newId()}::bigint, ${userId ?? null}, ${to}, ${kind}, ${subject}, ${status}, ${error})`.catch(() => {});
}

export async function sendMail(to: string, subject: string, text: string, meta: { kind?: string; userId?: string } = {}): Promise<void> {
	const kind = meta.kind ?? "other";
	if (!KEY) {
		await log(to, kind, subject, "skipped", "RESEND_API_KEY isn't set", meta.userId);
		throw new Error("mail isn't configured (RESEND_API_KEY)");
	}
	const r = await fetch("https://api.resend.com/emails", {
		method: "POST",
		headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
		body: JSON.stringify({ from: mailFrom(), to: [to], subject, text }),
		signal: AbortSignal.timeout(15_000),
	}).catch((e: Error) => e);
	if (r instanceof Error || !r.ok) {
		// Resend explains itself, e.g. that the sending domain isn't verified yet
		const error = r instanceof Error ? r.message : `Resend ${r.status}: ${(await r.text()).slice(0, 300)}`;
		await log(to, kind, subject, "failed", error, meta.userId);
		throw new Error(error);
	}
	await log(to, kind, subject, "sent", null, meta.userId);
}
