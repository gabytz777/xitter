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
export const idAt = (ms: number) => ((BigInt(ms) - EPOCH) << 22n).toString();

export const idTime = (id: string) => new Date(Number((BigInt(id) >> 22n) + EPOCH));

// an id that sorts at `at`, for things brought over with their own time
// (migration-import.ts); the low bits are random, so a clash with an id made
// in the same millisecond is unlikely and callers retry on one
export function newIdAt(at: Date): string {
	const ms = BigInt(Math.min(Math.max(at.getTime(), Number(EPOCH)), Date.now()));
	return (((ms - EPOCH) << 22n) | BigInt(crypto.getRandomValues(new Uint16Array(1))[0] & 0xfff)).toString();
}
