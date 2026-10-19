// Snowflake ids in the layout the client expects: sortable by time and safe to
// pass around as decimal strings.

const EPOCH = 1288834974657n;
let lastMs = 0n;
let seq = 0n;

export function newId(): string {
	let ms = BigInt(Date.now());
	if (ms <= lastMs) {
		ms = lastMs;
		seq = (seq + 1n) & 0xfffn;
		if (seq === 0n) ms = lastMs + 1n;
	} else seq = 0n;
	lastMs = ms;
	return (((ms - EPOCH) << 22n) | seq).toString();
}

export const isId = (v: unknown): v is string => typeof v === "string" && /^\d{1,19}$/.test(v) && BigInt(v) <= 9223372036854775807n;

// when an id was made
export const idTime = (id: string) => new Date(Number((BigInt(id) >> 22n) + EPOCH));
