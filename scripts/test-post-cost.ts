import { describe, expect, test } from "bun:test";
// Separate module instances keep this enabled-budget test meaningful even
// when the integration job globally disables request limits.
const previous = process.env.RATE_LIMITS;
delete process.env.RATE_LIMITS;
const { chargePostCost, hit, limitOf, limitedResponse, RateLimitError } = await import("../src/ratelimit.ts?post-cost-enabled");
process.env.RATE_LIMITS = "off";
const disabled = await import("../src/ratelimit.ts?post-cost-disabled");
if (previous === undefined) delete process.env.RATE_LIMITS;
else process.env.RATE_LIMITS = previous;
const viewer = () => ({ id: crypto.randomUUID() });

describe("scheduled post cost shares the ordinary post window", () => {
	test("middleware's first token plus the additional parts equals the full cost", () => {
		const v = viewer(), limit = limitOf("post");
		expect(hit("post", v.id).remaining).toBe(limit - 1);
		chargePostCost(v, limit - 2);
		expect(hit("post", v.id).remaining).toBe(0);
		expect(hit("post", v.id).ok).toBe(false);
	});
	test("an oversized reservation rejects atomically and smaller work can still fit", () => {
		const v = viewer(), limit = limitOf("post");
		expect(() => chargePostCost(v, limit + 1)).toThrow(RateLimitError);
		chargePostCost(v, limit - 1);
		expect(hit("post", v.id).remaining).toBe(0);
	});
	test("simultaneous reservations cannot overspend", async () => {
		const v = viewer(), limit = limitOf("post");
		const results = await Promise.allSettled(Array.from({ length: limit }, async () => chargePostCost(v, 2)));
		expect(results.filter((r) => r.status === "fulfilled").length).toBe(Math.floor(limit / 2));
		expect(hit("post", v.id).ok).toBe(limit % 2 === 1);
	});
	test("zero deltas and staff do not consume a post budget", () => {
		for (const role of [undefined, "admin", "moderator", "support"] as const) {
			const v = { ...viewer(), role };
			chargePostCost(v, role ? limitOf("post") * 2 : 0);
			expect(hit("post", v.id).remaining).toBe(limitOf("post") - 1);
		}
	});
	test("limited responses preserve code 88 and retry metadata", async () => {
		const v = viewer();
		chargePostCost(v, limitOf("post"));
		try { chargePostCost(v, 1); throw Error("unexpected allowance"); }
		catch (e) {
			expect(e).toBeInstanceOf(RateLimitError);
			const res = limitedResponse((e as InstanceType<typeof RateLimitError>).hit);
			expect(res.status).toBe(429);
			expect((await res.json()).errors[0].code).toBe(88);
			expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
			expect(res.headers.get("x-rate-limit-remaining")).toBe("0");
		}
	});
	test("invalid internal costs cannot mutate the budget", () => {
		const v = viewer();
		for (const cost of [-1, 0.5, Infinity, NaN]) expect(() => chargePostCost(v, cost)).toThrow(RangeError);
		expect(hit("post", v.id).remaining).toBe(limitOf("post") - 1);
	});
	test("RATE_LIMITS=off bypasses weighted reservations", () => {
		const v = viewer();
		disabled.chargePostCost(v, disabled.limitOf("post") * 2);
		expect(disabled.hit("post", v.id).remaining).toBe(disabled.limitOf("post"));
	});
});
