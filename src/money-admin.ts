// Admin > Money (admin.html): X Money's settings, how much money there is and
// where it went, and the tools to put it right: adjusting a balance and
// reversing a payment. Every change is in the audit log.

import { AdminError, type Action, audit, idOf } from "./admin";
import { sql } from "./db";
import { MoneyError, adjust, formatCents, parseAmount } from "./money";
import { feature, setSetting, settings } from "./settings";
import { allows } from "./staff-permissions";

// dollars typed in the panel ("100", "0.50") as cents, within limits
function cents(v: unknown, what: string, min: number, max: number) {
	const c = typeof v === "number" ? Math.round(v * 100) : parseAmount(String(v ?? ""));
	if (c === null || !Number.isSafeInteger(c) || c < min || c > max) throw new AdminError(`${what} is an amount from ${formatCents(min)} to ${formatCents(max)}.`);
	return c;
}

const handleOf = (u: string) => `@${u}`;

export const moneyActions: Record<string, Action> = {
	money: {
		role: "moderator",
		run: async (a, b) => {
			const q = typeof b.q === "string" ? b.q.trim().replace(/^@/, "") : "";
			const [totals] = await sql`select
					(select coalesce(sum(balance_cents), 0)::bigint from money_wallets) as circulation,
					(select count(*)::int from money_wallets) as wallets,
					(select count(*)::int from money_transfers where reversed_at is null) as payments,
					(select coalesce(sum(amount_cents), 0)::bigint from money_transfers where reversed_at is null) as volume,
					(select count(*)::int from money_transfers where reversed_at is null and created_at > now() - interval '7 days') as payments_week,
					(select coalesce(sum(amount_cents), 0)::bigint from money_transfers where reversed_at is null and created_at > now() - interval '7 days') as volume_week,
					(select coalesce(sum(cents), 0)::bigint from money_like_rewards) as likes_paid,
					(select count(*)::int from money_requests where status = 'open') as open_requests,
					(select count(*)::int from money_merchants) as merchants`;
			const top = await sql`select u.screen_name, u.name, u.avatar_url, u.verified_type, w.balance_cents::bigint as balance from money_wallets w join users u on u.id = w.user_id
				order by w.balance_cents desc, u.id limit 15`;
			const recent = await sql`select t.id::text, t.amount_cents::bigint as amount, t.note, t.created_at, t.reversed_at, s.screen_name as sender, r.screen_name as recipient
				from money_transfers t join users s on s.id = t.sender_id join users r on r.id = t.recipient_id
				${q ? sql`where lower(s.screen_name) = lower(${q}) or lower(r.screen_name) = lower(${q})` : sql``}
				order by t.id desc limit 50`;
			const n = (v: unknown) => Number(v);
			return {
				enabled: feature("money"),
				settings: settings().money,
				totals: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, n(v)])),
				top: top.map((r: any) => ({ ...r, balance: n(r.balance) })),
				// what people wrote on their payments is theirs: only staff who may put payments right see it
				recent: recent.map((r: any) => ({ ...r, amount: n(r.amount), note: allows(a.role, "money") ? r.note : "" })),
				notes: allows(a.role, "money"),
			};
		},
	},
	saveMoney: {
		role: "admin",
		run: async (a, b) => {
			const next = {
				starting_cents: cents(b.starting, "The starting balance", 0, 100_000_000),
				max_transfer_cents: cents(b.max_transfer, "The most one payment moves", 1, 10_000_000_000),
				like_cents: cents(b.like, "The like reward", 0, 100_000),
			};
			await setSetting("money", next);
			await audit(a, "money_settings", null, next);
			return { settings: next };
		},
	},
	adjustMoney: {
		role: "admin",
		run: async (a, b) => {
			const text = String(b.amount ?? "").trim();
			const c = parseAmount(text.replace(/^-/, ""));
			if (!c) throw new AdminError("Enter an amount, like 20 or -5.00.");
			try {
				return await adjust(a, String(b.handle ?? ""), text.startsWith("-") ? -c : c);
			} catch (e) {
				if (e instanceof MoneyError) throw new AdminError(e.message);
				throw e;
			}
		},
	},
	// the money goes back from the recipient to the sender, if they still have it
	reverseTransfer: {
		role: "admin",
		run: async (a, b) => {
			const id = idOf(b.id);
			return sql.begin(async (tx) => {
				const [t] = await tx`select t.sender_id::text, t.recipient_id::text, t.amount_cents::bigint as amount, t.reversed_at, r.screen_name as recipient
					from money_transfers t join users r on r.id = t.recipient_id where t.id = ${id}::bigint for update of t`;
				if (!t) throw new AdminError("There's no such payment.", 404);
				if (t.reversed_at) throw new AdminError("That payment was already reversed.");
				const amount = Number(t.amount);
				const wallets = await tx`select user_id::text, balance_cents from money_wallets where user_id in (${t.sender_id}::bigint, ${t.recipient_id}::bigint) order by user_id for update`;
				const theirs = Number(wallets.find((w: any) => w.user_id === t.recipient_id)?.balance_cents ?? 0);
				if (theirs < amount) throw new AdminError(`${handleOf(t.recipient)} has only ${formatCents(theirs)} left. Adjust their balance, or reverse less.`);
				await tx`update money_wallets set balance_cents = balance_cents - ${amount} where user_id = ${t.recipient_id}::bigint`;
				await tx`update money_wallets set balance_cents = balance_cents + ${amount} where user_id = ${t.sender_id}::bigint`;
				await tx`update money_transfers set reversed_at = now(), reversed_by = ${a.id}::bigint where id = ${id}::bigint`;
				await audit(a, "money_reverse", id, { amount, from: t.recipient_id, to: t.sender_id });
				return {};
			});
		},
	},
};
