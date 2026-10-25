// Admin > Server update (self-update.ts): which repositories and branches an
// admin's input names, and which ones SELF_UPDATE_REPOS allows.
import { expect, test } from "bun:test";
import { parseRepo, repoAllowed, validBranch } from "../src/self-update";

test("repositories are owner/name or their github.com address", () => {
	expect(parseRepo("Xittered/xitter")).toBe("Xittered/xitter");
	expect(parseRepo(" https://github.com/Xittered/xitter/ ")).toBe("Xittered/xitter");
	expect(parseRepo("https://github.com/Xittered/xitter.git")).toBe("Xittered/xitter");
	expect(parseRepo("github.com/some-one/my.fork")).toBe("some-one/my.fork");
	for (const bad of ["", "xitter", "https://gitlab.com/a/b", "http://github.com/a/b", "a/b/c", "a/..", "-x/y z", "file:///etc", "a/b;rm"]) expect(parseRepo(bad)).toBeNull();
});

test("branch names git takes and that aren't options", () => {
	for (const ok of ["main", "dev", "feature/self-update", "v1.2", "release_3"]) expect(validBranch(ok)).toBe(true);
	for (const bad of ["", "-f", "--upload-pack=x", "a..b", "a//b", "a/", "a.lock", "a/.b", "x@{1}", "a b", "a;b"]) expect(validBranch(bad)).toBe(false);
});

test("only the update repository unless SELF_UPDATE_REPOS says otherwise", () => {
	const before = { repos: process.env.SELF_UPDATE_REPOS, update: process.env.UPDATE_REPO };
	try {
		delete process.env.SELF_UPDATE_REPOS;
		delete process.env.UPDATE_REPO;
		expect(repoAllowed("xittered/xitter")).toBe(true);
		expect(repoAllowed("anyone/anything")).toBe(false);
		process.env.UPDATE_REPO = "me/fork";
		expect(repoAllowed("me/fork")).toBe(true);
		expect(repoAllowed("Xittered/xitter")).toBe(false);
		process.env.SELF_UPDATE_REPOS = "Xittered/xitter, me/fork";
		expect(repoAllowed("xittered/XITTER")).toBe(true);
		expect(repoAllowed("someone/else")).toBe(false);
		process.env.SELF_UPDATE_REPOS = "*";
		expect(repoAllowed("someone/else")).toBe(true);
	} finally {
		for (const [key, value] of [["SELF_UPDATE_REPOS", before.repos], ["UPDATE_REPO", before.update]] as const) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});
