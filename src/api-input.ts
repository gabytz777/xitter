// Count actual streamed bytes: Content-Length can be absent or inaccurate.
export class BodyTooLarge extends Error {}

export async function boundedBody(req: Request, maxBytes: number): Promise<Uint8Array> {
	if (Number(req.headers.get("content-length") ?? 0) > maxBytes) {
		await req.body?.cancel().catch(() => {});
		throw new BodyTooLarge();
	}
	if (!req.body) return new Uint8Array();
	const reader = req.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > maxBytes) {
				await reader.cancel().catch(() => {});
				throw new BodyTooLarge();
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}
