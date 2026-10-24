import { expect, test } from "bun:test";
import { sniffImage } from "../src/media";
import { shrinkPhoto } from "../src/media-compress";

// a PNG header and nothing else: enough for the size checks, which run before ffmpeg
function png(width: number, height: number, extra = ""): Buffer {
	const b = Buffer.alloc(33);
	b.writeUInt32BE(0x89504e47, 0);
	b.writeUInt32BE(0x0d0a1a0a, 4);
	b.writeUInt32BE(13, 8);
	b.write("IHDR", 12, "latin1");
	b.writeUInt32BE(width, 16);
	b.writeUInt32BE(height, 20);
	b[24] = 8;
	b[25] = 2;
	if (!extra) return b;
	const chunk = Buffer.alloc(12 + 8);
	chunk.writeUInt32BE(8, 0);
	chunk.write(extra, 4, "latin1");
	return Buffer.concat([b, chunk]);
}

test("a photo too big to decode is kept as it came, without ffmpeg", async () => {
	const data = png(16000, 16000);
	const kept = await shrinkPhoto(data, sniffImage(data)!);
	expect(kept?.data).toBe(data);
});

test("an animated PNG is kept as it came, so the sweep doesn't look at it again", async () => {
	const data = png(100, 100, "acTL");
	const kept = await shrinkPhoto(data, sniffImage(data)!);
	expect(kept?.data).toBe(data);
});

test("what isn't a photo isn't tried", async () => {
	const data = Buffer.from("GIF89a\x01\x00\x01\x00", "latin1");
	expect(await shrinkPhoto(data, sniffImage(data)!)).toBeUndefined();
});
