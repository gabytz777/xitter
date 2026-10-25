// Admin > Server update: admins update a git checkout of Xitter from the panel,
// from Xittered/xitter or any GitHub repository they name, without shell
// access. Off unless SELF_UPDATE=on, since it runs whatever code that
// repository holds as this server's user. Only the update repository unless
// SELF_UPDATE_REPOS names others, or is * for any.
//
// The steps are the ones an owner runs by hand: a database backup (backups.ts),
// note the commit, point origin at the repository, fetch the branch, check it out
// (the repository's default when none is named), bun install. The new code is
// then bundled once, so a syntax error or a missing module goes back to the
// previous commit instead of taking the server down. Last, the process exits
// for systemd or Docker to start it again (SELF_UPDATE_RESTART runs a command
// instead). The schema migrates on start; going back doesn't undo that, which
// is what the backup is for.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createBackup } from "./backups";
import { setSetting } from "./settings";
import { COMMIT } from "./version";

const root = join(import.meta.dir, "..");
const STATE_FILE = process.env.SELF_UPDATE_FILE ?? "data/self-update.json";
// systemd's Restart=on-failure starts a process again only after a non-zero exit
const EXIT_CODE = 75;

export const selfUpdateEnabled = () => process.env.SELF_UPDATE === "on";
const isCheckout = () => existsSync(join(root, ".git"));

export type UpdateRun = {
	kind: "update" | "rollback";
	by: string;
	repo: string;
	branch: string | null;
	from: string | null;
	to: string | null;
	backup: string | null;
	state: "running" | "restarting" | "done" | "failed";
	error: string | null;
	log: string[];
	started_at: string;
	finished_at: string | null;
};
type Saved = { previous: { sha: string; branch: string } | null; last: UpdateRun | null };

let saved: Saved = load();
let busy = false;

function load(): Saved {
	try {
		const s = JSON.parse(readFileSync(STATE_FILE, "utf8")) as Saved;
		// the process that wrote "restarting" is gone, so the restart happened
		if (s.last?.state === "restarting") {
			s.last.state = "done";
			s.last.finished_at = new Date().toISOString();
			s.last.log.push(`Started again on ${COMMIT ?? "an unknown commit"}.`);
		}
		return { previous: s.previous ?? null, last: s.last ?? null };
	} catch {
		return { previous: null, last: null };
	}
}

function save() {
	mkdirSync(dirname(STATE_FILE), { recursive: true });
	writeFileSync(STATE_FILE, JSON.stringify(saved, null, "\t"));
}

// "owner/repo", or its github.com address with or without https:// and .git
export function parseRepo(input: string): string | null {
	const m = /^(?:(?:https:\/\/)?(?:www\.)?github\.com\/)?([A-Za-z0-9-]{1,39})\/([\w.-]{1,100}?)(?:\.git)?\/?$/.exec(input.trim());
	if (!m || m[2] === "." || m[2] === "..") return null;
	return `${m[1]}/${m[2]}`;
}

// a name git takes for a branch, and that can't be read as an option
export const validBranch = (b: string) =>
	/^[\w][\w./-]{0,99}$/.test(b) && !/\.\.|\/\/|\/\.|@\{|\.lock$|\/$|\.$/.test(b);

// what an admin may update from. Unset, the update repository alone: with any
// repository allowed, one phished admin account is arbitrary code on the server.
// Not update_source, which an admin sets by updating.
export function allowedRepos(): string[] | "*" {
	const list = (process.env.SELF_UPDATE_REPOS ?? "").split(",").map((x) => x.trim()).filter(Boolean);
	if (list.includes("*")) return "*";
	return list.length ? list : [process.env.UPDATE_REPO || "Xittered/xitter"];
}

export function repoAllowed(repo: string) {
	const allowed = allowedRepos();
	return allowed === "*" || allowed.some((x) => x.toLowerCase() === repo.toLowerCase());
}

export function selfUpdateStatus() {
	return {
		enabled: selfUpdateEnabled(),
		checkout: isCheckout(),
		allowed_repos: allowedRepos(),
		commit: COMMIT,
		previous: saved.previous,
		last: saved.last,
		running: busy,
	};
}

// refuses before the password is asked for, so a switched-off instance doesn't use up tries
export function selfUpdateReady() {
	if (!selfUpdateEnabled()) throw new Error("Updating from the panel is off. The owner turns it on with SELF_UPDATE=on.");
	if (!isCheckout()) throw new Error("This instance isn't a git checkout (a Docker image, say), so it updates on the server: git pull, then docker compose up -d --build.");
	if (busy) throw new Error("An update is already running.");
}

async function run(r: UpdateRun, cmd: string[], timeout = 10 * 60_000) {
	r.log.push("$ " + cmd.join(" "));
	save();
	const p = Bun.spawn(cmd, {
		cwd: root,
		env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		timeout,
	});
	const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
	const text = (out + err).trim();
	if (text) r.log.push(text.split("\n").slice(-30).join("\n").slice(-4000));
	save();
	const name = cmd[0] === process.execPath ? "bun" : cmd[0];
	if (code !== 0) throw new Error(`${name} ${cmd[1]} failed${p.signalCode ? ` (${p.signalCode})` : ` with exit ${code}`}`);
	return out.trim();
}

const git = (r: UpdateRun, ...args: string[]) => run(r, ["git", ...args]);
const bun = (r: UpdateRun, ...args: string[]) => run(r, [process.execPath, ...args]);

// whether the checked-out code loads: every import resolves and every file parses
async function bundles(r: UpdateRun) {
	const out = mkdtempSync(join(tmpdir(), "xitter-update-"));
	try {
		await bun(r, "build", "src/server.ts", "--target=bun", "--outdir", out).catch(() => {
			throw new Error("The new code doesn't load (the log says where)");
		});
	} finally {
		rmSync(out, { recursive: true, force: true });
	}
}

function restart(r: UpdateRun) {
	r.state = "restarting";
	r.log.push("Restarting…");
	save();
	// let the panel's request that sees "restarting" finish first
	setTimeout(() => {
		const command = process.env.SELF_UPDATE_RESTART;
		if (!command) process.exit(EXIT_CODE);
		const p = Bun.spawn(["sh", "-c", command], { cwd: root, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
		// a command that works ends this process before it exits itself
		void p.exited.then((code) => {
			if (code === 0) return;
			fail(r, new Error(`SELF_UPDATE_RESTART exited with ${code}; the new code runs after the next restart`));
			busy = false;
		});
	}, 1500);
}

function begin(kind: UpdateRun["kind"], by: string, repo: string, branch: string | null): UpdateRun {
	busy = true;
	const r: UpdateRun = { kind, by, repo, branch, from: null, to: null, backup: null, state: "running", error: null, log: [], started_at: new Date().toISOString(), finished_at: null };
	saved.last = r;
	save();
	return r;
}

function fail(r: UpdateRun, e: unknown) {
	r.state = "failed";
	r.error = e instanceof Error ? e.message : String(e);
	r.finished_at = new Date().toISOString();
	r.log.push("Failed: " + r.error);
	save();
}

async function checkout(r: UpdateRun, branch: string, ref: string) {
	await git(r, "checkout", "-B", branch, ref);
	await bun(r, "install");
	await bundles(r);
}

async function updating(r: UpdateRun, url: string) {
	const sha = await git(r, "rev-parse", "HEAD");
	const current = await git(r, "rev-parse", "--abbrev-ref", "HEAD");
	const origin = await git(r, "remote", "get-url", "origin").catch(() => "");
	r.from = sha;
	r.backup = (await createBackup()).name;
	r.log.push(`Backed up the database to ${r.backup}.`);
	const restoreOrigin = () => (origin ? git(r, "remote", "set-url", "origin", origin).catch(() => {}) : undefined);
	try {
		await git(r, "remote", "set-url", "origin", url);
		const reach = () => {
			throw new Error(`Couldn't reach ${r.repo}: it doesn't exist, it's private, or GitHub can't be reached`);
		};
		if (!r.branch) {
			const head = await git(r, "ls-remote", "--symref", "origin", "HEAD").catch(reach);
			r.branch = /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(head)?.[1] ?? "";
		}
		if (!validBranch(r.branch)) throw new Error(`The repository's default branch "${r.branch}" can't be used here.`);
		// by name, since a single-branch clone's fetch brings only the branch it was cloned with
		await git(r, "fetch", "--no-tags", "origin", `+refs/heads/${r.branch}:refs/remotes/origin/${r.branch}`).catch(async () => {
			if (!(await git(r, "ls-remote", "--heads", "origin").catch(reach))) reach();
			throw new Error(`${r.repo} has no branch ${r.branch}.`);
		});
		r.to = await git(r, "rev-parse", "--verify", `refs/remotes/origin/${r.branch}^{commit}`).catch(() => {
			throw new Error(`${r.repo} has no branch ${r.branch}.`);
		});
	} catch (e) {
		await restoreOrigin();
		throw e;
	}
	// a detached checkout goes back on a branch of its own name
	const back = current === "HEAD" ? "main" : current;
	try {
		await checkout(r, r.branch, `origin/${r.branch}`);
	} catch (e) {
		r.log.push(`Going back to ${sha.slice(0, 12)}.`);
		await checkout(r, back, sha).catch((x) => r.log.push("Couldn't go back: " + (x as Error).message));
		await restoreOrigin();
		throw e;
	}
	saved.previous = { sha, branch: back };
	// the banner's update check follows the repository the instance now runs
	await setSetting("update_source", { repo: r.repo, branch: r.branch });
	restart(r);
}

// the repository and branch an admin asked for, refused before their two-factor code is spent
export function updateTarget(repoInput: string, branchInput: string) {
	selfUpdateReady();
	const allowed = allowedRepos();
	const repo = parseRepo(repoInput || (allowed === "*" ? "Xittered/xitter" : allowed[0]));
	if (!repo) throw new Error("Enter a GitHub repository like Xittered/xitter.");
	if (!repoAllowed(repo)) throw new Error(`${repo} isn't one of the repositories this instance updates from (SELF_UPDATE_REPOS).`);
	const branch = branchInput.trim() || null;
	if (branch && !validBranch(branch)) throw new Error("That isn't a branch name.");
	return { repo, branch };
}

// starts an update and returns while it runs; the panel follows it through selfUpdateStatus
export function startSelfUpdate(by: string, repoInput: string, branchInput: string) {
	const { repo, branch } = updateTarget(repoInput, branchInput);
	const r = begin("update", by, repo, branch);
	void updating(r, `https://github.com/${repo}.git`)
		.catch((e) => fail(r, e))
		// a restarting server takes no second update
		.finally(() => (busy = r.state === "restarting"));
	return r;
}

// the commit before the last update, with its dependencies; the database stays as it is
export function startRollback(by: string) {
	selfUpdateReady();
	const prev = saved.previous;
	if (!prev) throw new Error("There's no earlier commit to go back to.");
	const r = begin("rollback", by, "", prev.branch);
	void (async () => {
		const sha = await git(r, "rev-parse", "HEAD");
		const current = await git(r, "rev-parse", "--abbrev-ref", "HEAD");
		r.from = sha;
		r.to = prev.sha;
		try {
			await checkout(r, prev.branch, prev.sha);
		} catch (e) {
			r.log.push(`Going back to ${sha.slice(0, 12)}.`);
			await checkout(r, current === "HEAD" ? prev.branch : current, sha).catch((x) => r.log.push("Couldn't go back: " + (x as Error).message));
			throw e;
		}
		// going back twice returns to the update
		saved.previous = { sha, branch: current === "HEAD" ? prev.branch : current };
		restart(r);
	})()
		.catch((e) => fail(r, e))
		// a restarting server takes no second update
		.finally(() => (busy = r.state === "restarting"));
	return r;
}
