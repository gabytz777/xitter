import { expect, test } from "bun:test";
import { FLAGS, flagList, flagSvg, flagValue, unknownFlag } from "../src/flags";

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

test("country flags sit beside the pride flags without taking their ids", async () => {
	const countries = Object.keys(FLAGS).filter((id) => id.startsWith("country-"));
	expect(countries.length).toBe(249);
	expect(FLAGS["country-br"]?.name).toBe("Brazil");
	expect(FLAGS["country-bi"]?.name).toBe("Burundi");
	expect(FLAGS.bi?.name).toBe("Bisexual");
	expect(countries.every((id) => /^country-[a-z]{2}$/.test(id))).toBe(true);
	expect(flagValue("country-br,pride,country-jp")).toBe("country-br,pride,country-jp");
	expect(unknownFlag("country-zz")).toBe(true);
	expect(await flagSvg("pride")).toStartWith("<svg");
	expect(await flagSvg("country-zz")).toBeUndefined();
});

test("every pride flag has its badge in public/flags/pride", async () => {
	const pride = Object.keys(FLAGS).filter((id) => !id.startsWith("country-"));
	expect(pride.length).toBeGreaterThanOrEqual(85);
	for (const id of pride) expect((await flagSvg(id))?.startsWith("<svg")).toBe(true);
});

test("every country flag is saved in public/flags", async () => {
	const countries = Object.keys(FLAGS).filter((id) => id.startsWith("country-"));
	const svgs = await Promise.all(countries.map((id) => flagSvg(id)));
	expect(countries.filter((id, i) => !svgs[i]?.startsWith("<svg"))).toEqual([]);
});

test("admin lists render country flag images", async () => {
	const source = await Bun.file(new URL("../src/admin.html", import.meta.url)).text();
	const line = source.split("\n").find((line) => line.startsWith("const flagImg = "))!;
	const render = new Function("esc", line + "; return flagImg;")((s: unknown) => String(s ?? ""));
	expect(render({ flag: "country-br,trans" })).toBe('<img class="flag" alt="country-br" src="/public/flag-country-br.svg"> <img class="flag" alt="trans" src="/public/flag-trans.svg">');
});
