import { expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { Glob } from "bun";
import { allCountries, countryCode } from "../src/countries";
import { patchText } from "../src/patch";
import { replyControl, replyCountrySelections, ReplyControlError } from "../src/reply-controls";

test("country choices include all ISO countries and territories plus Kosovo", () => {
	const countries = allCountries();
	let code: string;
	expect(countries).toHaveLength(250);
	for (code of ["AQ", "SH", "MQ", "GP", "SJ", "BV", "HM", "TF", "UM", "XK"]) expect(countries.some((country) => country.code === code)).toBe(true);
	expect(countryCode(" sweden ")).toBe("SE");
	expect(countryCode("se")).toBe("SE");
});

test("reply audiences normalize native composer modes and preserve custom countries", () => {
	expect(replyControl(undefined).policy).toBeNull();
	expect(replyControl("all").policy).toBeNull();
	expect(replyControl("my_network").policy).toBe("MyNetwork");
	expect(replyControl("Country", ["SE", " Mars ", "Mars"])).toEqual({ policy: "Country", selections: ["SE", "Mars"], values: ["se", "sweden", "Mars", "mars"] });
	expect(replyControl("co", ["Europe"]).values).toContain("sweden");
	expect(replyControl("co", ["Europe"]).values).toContain("se");
	expect(replyControl("co", ["Europe"]).values).not.toContain("us");
	expect(replyControl("CountryOfOrigin", ["Antarctica"]).values).toContain("aq");
});

test("unknown audiences fall back to Everyone and log a bounded diagnostic", () => {
	const warn = spyOn(console, "warn").mockImplementation(() => {});
	let mode: unknown;
	try {
		for (mode of ["FutureClientMode", 123, null, {}, "constructor", "__proto__", "a".repeat(2000)]) expect(replyControl(mode)).toEqual({ policy: null, selections: [], values: [] });
		expect(warn).toHaveBeenCalledTimes(7);
		expect(String(warn.mock.calls.at(-1)?.[1]).length).toBeLessThan(130);
	} finally {
		warn.mockRestore();
	}
});

test("malformed geographic audiences cannot silently become unrestricted posts", () => {
	let selection: unknown;
	for (selection of [[], null, "SE", [123], [""], ["a".repeat(101)], Array(1001).fill("SE")]) expect(() => replyControl("Country", selection)).toThrow(ReplyControlError);
	expect(() => replyControl("co", ["Mars"])).toThrow(ReplyControlError);
});

test("country list validation also works without a geographic audience", () => {
	let selection: unknown;
	expect(replyCountrySelections()).toEqual([]);
	expect(replyCountrySelections([" Mars ", "SE", "Mars"])).toEqual(["Mars", "SE"]);
	for (selection of [null, "SE", [123], [""], ["a".repeat(101)], Array(1001).fill("SE")]) expect(() => replyCountrySelections(selection)).toThrow(ReplyControlError);
});

test("country serialization survives creation, mutation and normalization", () => {
	const create = '"co"===t.conversation_control?{mode:"CountryOfOrigin",allowed_country_codes:t.conversation_control_region_codes??[]}:void 0';
	const mutation = 'let r;if("co"===n&&(r="CountryOfOrigin"),void 0!==r)return {mode:r,allowed_country_codes:"co"===n?o:void 0}';
	const normalized = 'switch(e){case"Co":return"co";default:return e}';
	expect(new Function("t", `return ${patchText(create)}`)({ conversation_control: "country", conversation_control_region_codes: ["Mars"] })).toEqual({ mode: "Country", allowed_country_codes: ["Mars"] });
	expect(new Function("n", "o", patchText(mutation))("country", ["Mars"])).toEqual({ mode: "Country", allowed_country_codes: ["Mars"] });
	expect(new Function("e", patchText(normalized))("Country")).toBe("country");
});

test("newer clients preserve Country when their policies array replaces the legacy request", () => {
	const source = 'const mapping=new Map([["community","Community"],["co","CountryOfOrigin"]]);const modes=policies.map(policy=>mapping.get(policy)).filter(Boolean);return modes.length?{mode:modes[0],modes,allowed_country_codes:modes.includes("CountryOfOrigin")?codes??[]:void 0}:void 0';
	const convert = new Function("policies", "codes", patchText(source));
	expect(convert(["country"], ["Mars"])).toEqual({ mode: "Country", modes: ["Country"], allowed_country_codes: ["Mars"] });
	expect(convert(["co"], ["Europe"])).toEqual({ mode: "CountryOfOrigin", modes: ["CountryOfOrigin"], allowed_country_codes: ["Europe"] });
	expect(convert(["community"], []).mode).toBe("Community");
});

test.skipIf(!existsSync("client/abs/responsive-web/client-web"))("both native reply menus include searchable Country choices and remain valid JavaScript", async () => {
	const glob = new Glob("{shared~bundle.Compose~bundle.RichTextCompose.*,loader.TweetCurationActionMenu.*}.js");
	const transpiler = new Bun.Transpiler({ loader: "js" });
	let path: string, patched: string;
	for await (path of glob.scan("client/abs/responsive-web/client-web")) {
		patched = patchText(await Bun.file(`client/abs/responsive-web/client-web/${path}`).text());
		expect(patched).toContain('Country:{id:"country"');
		expect(patched).toContain('"aria-label":"Search countries or regions"');
		expect(patched).toContain('filter(e=>e.label.toLocaleLowerCase()');
		expect(() => transpiler.transformSync(patched)).not.toThrow();
	}
});
