// What this instance runs, for account migration (migration.ts) and
// /.well-known/xitter. The version is package.json's unless XITTER_VERSION
// overrides it; the schema fingerprint changes whenever schema.sql does, so two
// instances on the same version label but different database shapes still tell
// each other apart. The commit is read from .git when there is one (not in the
// Docker image) and is only shown, never compared.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: string };
export const VERSION = (process.env.XITTER_VERSION || pkg.version || "0.0.0").slice(0, 40);

export const SCHEMA = createHash("sha256").update(readFileSync(join(import.meta.dir, "schema.sql"))).digest("hex").slice(0, 16);

function gitCommit(): string | null {
	try {
		const git = join(root, ".git");
		if (!existsSync(git)) return null;
		const head = readFileSync(join(git, "HEAD"), "utf8").trim();
		if (/^[0-9a-f]{40}$/.test(head)) return head.slice(0, 12);
		const ref = /^ref: (refs\/[\w./-]+)$/.exec(head)?.[1];
		if (!ref) return null;
		if (existsSync(join(git, ref))) return readFileSync(join(git, ref), "utf8").trim().slice(0, 12);
		const packed = existsSync(join(git, "packed-refs")) ? readFileSync(join(git, "packed-refs"), "utf8") : "";
		return new RegExp(`^([0-9a-f]{40}) ${ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m").exec(packed)?.[1].slice(0, 12) ?? null;
	} catch {
		return null;
	}
}

export const COMMIT = process.env.XITTER_COMMIT?.slice(0, 40) || gitCommit();

// the newest account-migration archive format this instance reads and writes
// (migration.ts); another instance refuses archives newer than it knows
export const MIGRATION_FORMAT_VERSION = 1;
