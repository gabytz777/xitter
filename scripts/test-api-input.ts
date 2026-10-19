import { describe, expect, test } from "bun:test";
import { BodyTooLarge, boundedBody } from "../src/api-input";

function streamed(chunks: number[], contentLength?: string) {
	let cancelled = false;
	let index = 0;
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (index === chunks.length) controller.close();
			else controller.enqueue(new Uint8Array(chunks[index++]).fill(65));
		},
		cancel() { cancelled = true; },
	});
	const req = new Request("https://example.test", {
		method: "POST", body: stream,
		headers: contentLength === undefined ? {} : { "content-length": contentLength },
	});
	return { req, cancelled: () => cancelled };
}

describe("API body bounds", () => {
	test("accepts exactly the limit and preserves all chunks", async () => {
		const { req } = streamed([2, 3]);
		expect(await boundedBody(req, 5)).toEqual(new Uint8Array(5).fill(65));
		expect(req.body!.locked).toBe(false);
	});
	for (const length of [undefined, "1"]) {
		test(`cancels an overflowing stream with content-length ${length}`, async () => {
			const s = streamed([3, 3, 3, 3], length);
			await expect(boundedBody(s.req, 5)).rejects.toBeInstanceOf(BodyTooLarge);
			expect(s.cancelled()).toBe(true);
			expect(s.req.body!.locked).toBe(false);
		});
	}
	test("rejects and cancels an announced oversized body before reading it", async () => {
		const s = streamed([1], "100");
		await expect(boundedBody(s.req, 5)).rejects.toBeInstanceOf(BodyTooLarge);
		expect(s.cancelled()).toBe(true);
	});
	test("handles a missing body", async () => {
		expect(await boundedBody(new Request("https://example.test"), 5)).toEqual(new Uint8Array());
	});
	test("releases the reader if the incoming stream fails", async () => {
		const req = new Request("https://example.test", { method: "POST", body: new ReadableStream({ start(c) { c.error(new Error("disconnected")); } }) });
		await expect(boundedBody(req, 5)).rejects.toThrow("disconnected");
		expect(req.body!.locked).toBe(false);
	});
	test("cancellation failures still report an oversized body", async () => {
		for (const announced of [false, true]) {
			const req = new Request("https://example.test", {
				method: "POST",
				headers: announced ? { "content-length": "100" } : {},
				body: new ReadableStream({
					pull(c) { c.enqueue(new Uint8Array(6)); },
					cancel() { throw new Error("transport already closed"); },
				}),
			});
			await expect(boundedBody(req, 5)).rejects.toBeInstanceOf(BodyTooLarge);
			expect(req.body!.locked).toBe(false);
		}
	});
});
