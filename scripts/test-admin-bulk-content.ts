import { expect, test } from "bun:test";

const source = await Bun.file(new URL("../src/admin.html", import.meta.url)).text();

test("bulk post actions confirm once, preserve other flags and retain only failures", async () => {
	const start = source.indexOf('\t\tmain.querySelectorAll("#phide, #psens, #pdel")');
	const code = source.slice(start, source.indexOf("\n\t\tlet t;", start));
	for (const action of ["phide", "psens", "pdel"]) {
		const buttons = ["phide", "psens", "pdel"].map((id) => ({ id, disabled: false, onclick: undefined as any }));
		const result = { textContent: "" };
		const main = { querySelectorAll: () => buttons };
		const posts = [{ id: "1", hidden: true, sensitive: true }, { id: "2", hidden: false, sensitive: false }, { id: "3", hidden: false, sensitive: true }];
		const calls: { action: string; body: any }[] = [];
		let confirmations = 0;
		let retained: string[] = [];
		new Function("main", "$", "ppicked", "ask", "api", "posts", "load", "notice", code)(
			main, () => result, () => ["1", "2", "3"], async () => { confirmations++; return true; },
			async (action: string, body: any) => { calls.push({ action, body }); if (body.id === "2") throw new Error("protected account"); },
			posts, async (_more: boolean, keep: string[]) => { retained = keep; }, () => {},
		);
		await buttons.find((b) => b.id === action)!.onclick();
		expect(confirmations).toBe(1);
		expect(calls).toHaveLength(3);
		expect(retained).toEqual(["2"]);
		expect(result.textContent).toContain("2 succeeded, 1 failed.");
		expect(result.textContent).toContain("protected account");
		expect(buttons.every((b) => !b.disabled)).toBe(true);
		if (action === "pdel") expect(calls.every((c) => c.action === "deletePost")).toBe(true);
		else {
			expect(calls[0]).toEqual({ action: "setPostVisibility", body: { id: "1", hidden: true, sensitive: true } });
			expect(calls[2].body).toEqual({ id: "3", hidden: action === "phide", sensitive: true });
		}
	}
});

test("bulk media deletion continues after a failure and removes only successful items", async () => {
	const start = source.indexOf('\t\tif ($("#mdel"))');
	const code = source.slice(start, source.indexOf("\n\t\tconst load =", start));
	const button = { disabled: false, onclick: undefined as any }, result = { textContent: "" };
	const removed: string[] = [];
	let confirmations = 0, updates = 0;
	const offset = await new Function("$", "mpicked", "ask", "api", "main", "updateMediaPick", "return (async () => { let offset = 3; " + code + '; await $("#mdel").onclick(); return offset; })();')(
		(selector: string) => selector === "#mdel" ? button : result, () => ["1", "2", "3"], async () => { confirmations++; return true; },
		async (_action: string, body: any) => { if (body.id === "2") throw new Error("protected account"); },
		{ querySelector: (selector: string) => ({ remove: () => removed.push(selector) }) }, () => { updates++; },
	);
	expect(confirmations).toBe(1);
	expect(removed).toEqual(['[data-media="1"]', '[data-media="3"]']);
	expect(offset).toBe(1);
	expect(updates).toBe(1);
	expect(result.textContent).toContain("2 deleted, 1 failed.");
	expect(button.disabled).toBe(false);
});
