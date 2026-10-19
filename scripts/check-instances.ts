import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);
const flag = (name: string) => {
	const i = args.indexOf(name);
	return i < 0 ? undefined : args[i + 1];
};
const file = flag("--file") ?? "instances.json";
const baseFile = flag("--base");
const online = args.includes("--online");
const writeMd = args.includes("--write-md");

const ID_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const KEY_RE = /^[A-Za-z0-9_-]{43}$/;
const STATES = ["active", "suspended", "blocked"];
const FIELDS = ["id", "name", "source_url", "public_key", "state"];

const errors: string[] = [];
const touched = new Set<string>();
const notes: string[] = [];

const load = (path: string) => {
	const text = readFileSync(path, "utf8");
	try {
		return { text, data: JSON.parse(text) };
	} catch (e) {
		errors.push(`${path} is not valid JSON: ${(e as Error).message}`);
		return { text, data: undefined };
	}
};

const { text, data } = load(file);
if (data) {
	if (data.version !== 1) errors.push("version must be 1");
	if (!Number.isSafeInteger(data.sequence) || data.sequence < 1) errors.push("sequence must be a positive integer");
	if (!Array.isArray(data.instances)) errors.push("instances must be an array");
	const extra = Object.keys(data).filter((k) => !["version", "sequence", "instances"].includes(k));
	if (extra.length) errors.push(`unknown top-level fields: ${extra.join(", ")}`);
	if (`${JSON.stringify(data, null, "\t")}\n` !== text) errors.push(`${file} must be formatted with tabs and a trailing newline, as JSON.stringify(data, null, "\\t") writes it`);
}

const instances: any[] = Array.isArray(data?.instances) ? data.instances : [];
const seen = new Set<string>();
const keys = new Map<string, string>();
for (const [n, i] of instances.entries()) {
	const at = `instances[${n}]${typeof i?.id === "string" ? ` (${i.id})` : ""}`;
	if (!i || typeof i !== "object") {
		errors.push(`${at} must be an object`);
		continue;
	}
	const extra = Object.keys(i).filter((k) => !FIELDS.includes(k));
	if (extra.length) errors.push(`${at} has unknown fields: ${extra.join(", ")}`);
	const missing = FIELDS.filter((k) => !(k in i));
	if (missing.length) errors.push(`${at} is missing ${missing.join(", ")}`);
	if (typeof i.id !== "string" || !ID_RE.test(i.id)) errors.push(`${at} id must be a lowercase hostname without a scheme, port or path`);
	else if (seen.has(i.id)) errors.push(`${at} is listed twice`);
	else seen.add(i.id);
	if (typeof i.name !== "string" || !i.name.trim() || i.name.length > 50) errors.push(`${at} name must be 1 to 50 characters`);
	if (i.source_url !== null && (typeof i.source_url !== "string" || !/^https:\/\/[^\s]+$/.test(i.source_url) || i.source_url.length > 300)) errors.push(`${at} source_url must be null or an https link of at most 300 characters`);
	if (!STATES.includes(i.state)) errors.push(`${at} state must be one of ${STATES.join(", ")}`);
	if (i.public_key !== null) {
		if (typeof i.public_key !== "string" || !KEY_RE.test(i.public_key) || Buffer.from(i.public_key, "base64url").toString("base64url") !== i.public_key) errors.push(`${at} public_key must be null or the 43-character key from /.well-known/xitter`);
		else if (keys.has(i.public_key)) errors.push(`${at} uses the same public_key as ${keys.get(i.public_key)}`);
		else keys.set(i.public_key, i.id);
	} else if (i.state === "active") notes.push(`${i.id} has no public_key, so peers pin its key on first contact`);
}
const sorted = [...seen].sort();
if ([...seen].some((id, n) => id !== sorted[n])) errors.push("instances must be sorted by id");

if (baseFile && data) {
	const base = load(baseFile).data;
	if (base) {
		const before = new Map<string, any>((base.instances ?? []).map((i: any) => [i.id, i]));
		const changed = JSON.stringify(base.instances) !== JSON.stringify(data.instances);
		if (changed && !(data.sequence > base.sequence)) errors.push(`the list changed, so sequence must go above ${base.sequence}`);
		if (data.sequence < base.sequence) errors.push(`sequence went back from ${base.sequence} to ${data.sequence}, and instances refuse a list that does that`);
		for (const i of instances) {
			const old = before.get(i.id);
			if (JSON.stringify(old) !== JSON.stringify(i)) touched.add(i.id);
			if (!old) notes.push(`added ${i.id} (${i.state})`);
			else {
				if (old.public_key && old.public_key !== i.public_key) notes.push(`KEY CHANGE for ${i.id}: confirm it with its admins somewhere other than this pull request`);
				if (old.state !== i.state) notes.push(`${i.id} went from ${old.state} to ${i.state}`);
			}
			before.delete(i.id);
		}
		for (const id of before.keys()) notes.push(`removed ${id}. Setting its state to blocked keeps it blocked everywhere, while removing it only stops federation`);
	}
}

if (online && !errors.length) {
	for (const i of instances.filter((x) => x.state === "active" && (!baseFile || touched.has(x.id)))) {
		try {
			const res = await fetch(`https://${i.id}/.well-known/xitter`, { signal: AbortSignal.timeout(15_000), redirect: "error" });
			if (!res.ok) throw new Error(`answered ${res.status}`);
			const w = (await res.json()) as any;
			if (w?.software !== "xitter" || w?.id !== i.id) errors.push(`${i.id} serves a /.well-known/xitter for ${w?.id ?? "nothing"}`);
			else if (i.public_key && w.public_key !== i.public_key) errors.push(`${i.id} serves the key ${w.public_key}, not the one listed`);
			else if (!w.federation?.enabled) notes.push(`${i.id} has federation turned off`);
		} catch (e) {
			errors.push(`${i.id}/.well-known/xitter could not be read: ${(e as Error).message}`);
		}
	}
}

if (data && !errors.length) {
	const cell = (v: string) => v.replace(/[|\\`<>[\]]/g, (c) => `\\${c}`);
	const states: Record<string, string> = { active: "federating", suspended: "suspended, defederated everywhere", blocked: "blocked, defederated everywhere" };
	const md = `# Instances

Generated from [instances.json](instances.json), sequence ${data.sequence}. Edit that file, then run
\`bun scripts/check-instances.ts --write-md\` to update this one.

| Instance | Name | State | Key | Source |
| --- | --- | --- | --- | --- |
${instances.map((i) => `| [${i.id}](https://${i.id}) | ${cell(i.name)} | ${states[i.state]} | ${i.public_key ? `\`${i.public_key}\`` : "pinned on first contact"} | ${i.source_url ? `[code](${i.source_url})` : ""} |`).join("\n")}

[FEDERATION.md](FEDERATION.md) explains how to add an instance.
`;
	const mdFile = join(dirname(file), "INSTANCES.md");
	if (writeMd) writeFileSync(mdFile, md);
	else if (!existsSync(mdFile) || readFileSync(mdFile, "utf8") !== md) errors.push(`${mdFile} is out of date. Run bun scripts/check-instances.ts --write-md`);
}

for (const n of notes) console.log(`note: ${n}`);
for (const e of errors) console.error(`error: ${e}`);
if (errors.length) process.exit(1);
console.log(`${file}: ${instances.length} instances, sequence ${data.sequence}, ok`);
