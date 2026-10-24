import { expect, test } from "bun:test";
import { flagList, flagValue, unknownFlag } from "../src/flags";

test("flag selections preserve order, remove duplicates and clamp the fifth", () => {
	expect(flagList("trans,pride,trans,bi,pan,lesbian")).toEqual(["trans", "pride", "bi", "pan"]);
	expect(flagValue("trans,pride,bi,pan,lesbian")).toBe("trans,pride,bi,pan");
	expect(flagValue("")).toBeNull();
	expect(unknownFlag("trans,pride,bi,pan,lesbian")).toBe(false);
	expect(unknownFlag("pride,../invalid")).toBe(true);
});

test("admin lists render separate safe flag image URLs", async () => {
	const source = await Bun.file(new URL("../src/admin.html", import.meta.url)).text();
	const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, "");
	const line = source.split("\n").find((line) => line.startsWith("const flagImg = "))!;
	const render = new Function("esc", line + "; return flagImg;")(esc);
	const html = render({ flag: "trans,pride" });
	expect(html).toContain('src="/public/flag-trans.svg"');
	expect(html).toContain('src="/public/flag-pride.svg"');
	expect(html).not.toContain("trans,pride.svg");
	expect(render({ flag: '../bad,\" onerror=bad,pride' })).toBe('<img class="flag" alt="pride" src="/public/flag-pride.svg">');
	expect(render({ flag: null })).toBe("");
});
