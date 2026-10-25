// The update check's file comparison (update-check.ts): git's blob hashes,
// CRLF checkouts, and files the branch changed, added or removed.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blobSha, differingFiles } from "../src/update-check";

test("blob hashes are git's, with CRLF read as LF", () => {
	// git hash-object of "hello\n"
	expect(blobSha(Buffer.from("hello\n"))).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
	expect(blobSha(Buffer.from("hello\r\n"))).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
	// a binary file keeps its bytes
	expect(blobSha(Buffer.from([0, 13, 10]))).not.toBe(blobSha(Buffer.from([0, 10])));
});

test("files that differ, are new upstream or gone upstream all count", () => {
	const dir = mkdtempSync(join(tmpdir(), "xitter-update-"));
	try {
		const file = (name: string, text: string) => {
			const path = join(dir, name.replace(/\//g, "_"));
			writeFileSync(path, text);
			return path;
		};
		const local = new Map([
			["src/same.ts", file("src/same.ts", "same\n")],
			["src/changed.ts", file("src/changed.ts", "old\n")],
			["src/removed-upstream.ts", file("src/removed-upstream.ts", "x\n")],
		]);
		const blob = (path: string, text: string) => ({ path, type: "blob", sha: blobSha(Buffer.from(text)) });
		const tree = [blob("src/same.ts", "same\n"), blob("src/changed.ts", "new\n"), blob("src/added.ts", "y\n"), blob("instances.json", "{}"), { path: "src", type: "tree", sha: "" }];
		expect(differingFiles(tree, local)).toBe(3);
		expect(differingFiles([blob("src/same.ts", "same\n")], new Map([["src/same.ts", local.get("src/same.ts")!]]))).toBe(0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
