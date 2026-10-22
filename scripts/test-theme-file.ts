import { expect, test } from "bun:test";
import { THEME_SCRIPT } from "../src/themes/client";
import { bootCss, pageChromeCss, type BackgroundPaint } from "../src/themes/css";
import { type Theme } from "../src/themes/presets";
import {
	BACKGROUND_OMITTED,
	THEME_FILE_MAX,
	exportTheme,
	importTheme,
	finishBackground,
	parseLookWrite,
	sanitiseTheme,
} from "../src/themes/validate";
import { acceptThemePhoto } from "../src/media";
import { familyFromSlug, fontSlug, validateFamily } from "../src/fonts";

const custom: Theme = {
	id: "custom",
	base: "dark",
	bg: { stops: ["#0a0a12", "#180828"], angle: 120 },
	surface: "#121018",
	text: "#ffffff",
	accent: "#1d9bf0",
	button: { stops: ["#ffffff", "#eeeeee"], angle: 180 },
	buttonText: "#000000",
};

const fileOf = (theme: unknown) => JSON.stringify({ format: "xitter-theme", version: 1, theme });

const PNG_1X1 = Buffer.from(
	"89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082",
	"hex",
);

function gif({ width = 1, height = 1, extra = "" } = {}) {
	const b = Buffer.alloc(35);
	b.write("GIF89a", 0, "latin1");
	b.writeUInt16LE(width, 6);
	b.writeUInt16LE(height, 8);
	b[10] = 0;
	b[11] = 0;
	b[12] = 0;
	b[13] = 0x2c;
	b.writeUInt16LE(0, 14);
	b.writeUInt16LE(0, 16);
	b.writeUInt16LE(width, 18);
	b.writeUInt16LE(height, 20);
	b[22] = 0;
	b[23] = 2;
	b[24] = 2;
	b[25] = 0x4c;
	b[26] = 0x01;
	b[27] = 0;
	b[28] = 0x3b;
	return extra ? Buffer.concat([b.subarray(0, 29), Buffer.from(extra)]) : b.subarray(0, 29);
}

test("unknown keys are still dropped on read", () => {
	const got = sanitiseTheme({ id: "dim", extra: true, nested: { a: 1 } });
	expect(got?.theme.id).toBe("dim");
	expect(got && "extra" in got.theme).toBe(false);
});

test("save rejects an unknown theme key with a path", () => {
	const got = parseLookWrite({ theme: { id: "dim", extra: true } });
	expect(got.ok).toBe(false);
	if (got.ok) return;
	expect(got.errors?.some((e) => e.path === "extra" && /unknown/.test(e.message))).toBe(true);
});

test("import accepts a share file and strips a media id on export", () => {
	const painted = sanitiseTheme({
		...custom,
		background: { fit: "cover", position: "center", dim: 20, blur: 4, mediaId: "123" },
	})!.theme;
	const file = exportTheme(painted);
	expect(file.format).toBe("xitter-theme");
	expect(file.version).toBe(1);
	expect(file.theme.background).toEqual({ fit: "cover", position: "center", dim: 20, blur: 4, scale: 100, repeat: "repeat", panel: 72 });
	expect(JSON.stringify(file)).not.toContain("mediaId");
	expect(JSON.stringify(file)).not.toContain("/media/");
	const imported = importTheme(JSON.stringify(file));
	expect(imported.ok).toBe(true);
	if (!imported.ok) return;
	expect(imported.warnings).toContain(BACKGROUND_OMITTED);
	expect(imported.theme.background && "mediaId" in imported.theme.background).toBe(false);
});

test("a colour save keeps the stored picture", () => {
	const previous = sanitiseTheme({
		...custom,
		background: { fit: "cover", position: "top", dim: 10, blur: 2, mediaId: "123" },
	})!.theme;
	const next = finishBackground(previous, custom, "keep", { tag: "none" }, undefined);
	expect(next.ok && next.theme.background?.mediaId).toBe("123");
	const cleared = finishBackground(previous, custom, "clear", { tag: "none" }, undefined);
	expect(cleared.ok && cleared.theme.background).toBeUndefined();
});

test("peel keeps a picture only on custom themes", () => {
	const previous = sanitiseTheme({
		...custom,
		background: { fit: "cover", position: "center", dim: 30, blur: 2, mediaId: "123" },
	})!.theme;
	const dim = parseLookWrite({ theme: { id: "dim" } });
	expect(dim.ok).toBe(true);
	if (!dim.ok || dim.write.type !== "paint") return;
	const dimKept = finishBackground(previous, dim.write.theme, dim.write.peel, dim.write.source, undefined);
	expect(dimKept.ok && dimKept.theme.background).toBeUndefined();
	const sunset = parseLookWrite({ theme: { id: "sunset" } });
	expect(sunset.ok).toBe(true);
	if (!sunset.ok || sunset.write.type !== "paint") return;
	const sunsetKept = finishBackground(previous, sunset.write.theme, sunset.write.peel, sunset.write.source, undefined);
	expect(sunsetKept.ok && sunsetKept.theme.background).toBeUndefined();
	const painted = parseLookWrite({
		theme: {
			id: "custom",
			base: "dark",
			bg: { stops: ["#0a0a12"], angle: 120 },
			surface: "#121018",
			text: "#ffffff",
			accent: "#1d9bf0",
			button: { stops: ["#ffffff"], angle: 180 },
			buttonText: "#000000",
		},
	});
	expect(painted.ok).toBe(true);
	if (!painted.ok || painted.write.type !== "paint") return;
	const paintedKept = finishBackground(previous, painted.write.theme, painted.write.peel, painted.write.source, undefined);
	expect(paintedKept.ok && paintedKept.theme.background?.mediaId).toBe("123");
	const light = parseLookWrite({ mode: "light" });
	const dark = parseLookWrite({ mode: "dark" });
	expect(light.ok && light.write.type === "plain").toBe(true);
	expect(dark.ok && dark.write.type === "plain").toBe(true);
});

test("painted wrap skips Color options the same way accent wrap does", () => {
	const wrapFn = THEME_SCRIPT.slice(THEME_SCRIPT.indexOf("function wrap(sel, pageBg)"), THEME_SCRIPT.indexOf("function paint()"));
	const wrapAccentFn = THEME_SCRIPT.slice(THEME_SCRIPT.indexOf("function wrapAccent(sel)"), THEME_SCRIPT.indexOf("function paintAccent()"));
	expect(wrapAccentFn).toContain('[aria-label="Color options"] *');
	expect(wrapFn).toContain('[aria-label="Color options"] *');
	expect(THEME_SCRIPT).toContain('lightsCard.querySelector("input")');
});

const attacks = [
	"#fff;}body{display:none",
	"red",
	"expression(alert(1))",
	"javascript:alert(1)",
	"@import",
	"url(https://evil)",
	"</style><script>alert(1)</script>",
];

for (const attack of attacks) {
	test(`import rejects css injection ${attack.slice(0, 24)}`, () => {
		const fields = ["text", "buttonText", "surface", "accent", "link", "bg"];
		for (const field of fields) {
			const theme = { ...custom, bg: { ...custom.bg }, button: { ...custom.button } } as Record<string, unknown>;
			if (field === "bg") theme.bg = { stops: [attack, "#000000"], angle: 180 };
			else theme[field] = attack;
			const got = importTheme(fileOf(theme));
			expect(got.ok).toBe(false);
			if (got.ok) return;
			const blob = JSON.stringify(got);
			expect(blob).not.toContain("display:none");
			expect(pageChromeCss()).not.toContain(attack);
			expect(bootCss(custom)).not.toContain(attack);
		}
	});
}

test("import rejects prototype pollution keys", () => {
	const cases = [
		'{"format":"xitter-theme","version":1,"__proto__":{"polluted":true},"theme":{"id":"custom"}}',
		'{"format":"xitter-theme","version":1,"theme":{"constructor":{"prototype":{"x":1}},"id":"custom"}}',
		'{"format":"xitter-theme","version":1,"theme":{"prototype":{"x":1},"id":"custom"}}',
	];
	for (const text of cases) {
		const got = importTheme(text);
		expect(got.ok).toBe(false);
		if (got.ok) return;
		expect(got.errors.some((e) => /banned|unknown|forbidden/.test(e.message))).toBe(true);
		expect(JSON.stringify(got)).not.toContain("polluted");
	}
	expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
});

test("import rejects a file over 64 KB before parsing", () => {
	const text = `{"format":"xitter-theme","version":1,"theme":{"pad":"${"a".repeat(THEME_FILE_MAX)}"}}`;
	expect(Buffer.byteLength(text)).toBeGreaterThan(THEME_FILE_MAX);
	const got = importTheme(text);
	expect(got.ok).toBe(false);
	if (!got.ok) expect(got.errors[0]?.message).toBe("file is too large");
});

test("import rejects nesting deeper than 6", () => {
	const deep = { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } };
	const got = importTheme(fileOf({ ...custom, extra: deep }));
	expect(got.ok).toBe(false);
	if (!got.ok) expect(got.errors.some((e) => /deep|unknown/.test(e.message))).toBe(true);
});

test("import rejects extra keys at every level", () => {
	expect(importTheme(JSON.stringify({ format: "xitter-theme", version: 1, theme: custom, extra: 1 })).ok).toBe(false);
	expect(importTheme(fileOf({ ...custom, nope: true })).ok).toBe(false);
	expect(importTheme(fileOf({ ...custom, bg: { ...custom.bg, extra: 1 } })).ok).toBe(false);
	expect(importTheme(fileOf({ ...custom, font: { ui: "Inter", extra: 1 } })).ok).toBe(false);
	expect(importTheme(fileOf({ ...custom, background: { fit: "cover", position: "center", dim: 0, blur: 0, extra: 1 } })).ok).toBe(false);
});

test("import rejects wrong types and one-stop or hash-rgb colours", () => {
	expect(importTheme(fileOf({ ...custom, text: 12 })).ok).toBe(false);
	expect(importTheme(fileOf({ ...custom, text: "#fff" })).ok).toBe(false);
	expect(importTheme(fileOf({ ...custom, bg: { stops: ["#000000"], angle: 180 } })).ok).toBe(false);
	expect(importTheme(fileOf({ ...custom, bg: { stops: ["#000000", "#111111"], angle: "90" } })).ok).toBe(false);
	expect(importTheme(fileOf("dim")).ok).toBe(false);
});

test("import rejects bad font names and path-like slugs", () => {
	const names = ["../../etc", "Roboto;}", "Rоboto", "\u202eRoboto", "Inter</style>", "A".repeat(41)];
	for (const name of names) {
		expect(validateFamily(name)).toBeUndefined();
		const got = importTheme(fileOf({ ...custom, font: { ui: name } }));
		expect(got.ok).toBe(false);
		if (!got.ok) expect(JSON.stringify(got.errors)).not.toContain(name.replace(/"/g, ""));
	}
	expect(familyFromSlug("../etc")).toBeUndefined();
	expect(familyFromSlug("..")).toBeUndefined();
	expect(fontSlug("Inter")).toBe("inter");
});

test("import rejects a media id or a background url", () => {
	expect(importTheme(fileOf({ ...custom, background: { fit: "cover", position: "center", dim: 0, blur: 0, mediaId: "123" } })).ok).toBe(false);
	expect(importTheme(fileOf({ ...custom, background: { url: "https://evil/x.gif" } })).ok).toBe(false);
	expect(importTheme(fileOf({ ...custom, background: "https://evil/x.gif" })).ok).toBe(false);
	expect(importTheme(fileOf({ ...custom, bg: "url(https://evil)" })).ok).toBe(false);
});

test("save rejects a malformed media id", () => {
	const got = parseLookWrite({
		theme: {
			...custom,
			background: { fit: "cover", position: "center", dim: 0, blur: 0, mediaId: "../x" },
		},
	});
	expect(got.ok).toBe(false);
	if (!got.ok) expect(got.errors?.some((e) => e.path === "background.mediaId")).toBe(true);
});

test("page chrome only emits an allowlisted media url", () => {
	const paint = (image: string): BackgroundPaint => ({
		image,
		still: image.startsWith("/media/") ? "/media/poster/123.jpg" : null,
		fit: "cover",
		position: "center",
		dim: 20 as BackgroundPaint["dim"],
		blur: 4 as BackgroundPaint["blur"],
		scale: 100,
		repeat: "repeat",
		panel: 72,
		movie: null,
		mp4: null,
		defid: null,
	});
	const css = pageChromeCss(paint("/media/123.png"));
	expect(css).toContain('url("/media/123.png")');
	expect(css).toContain(":not([data-xitter-decor])");
	expect(pageChromeCss(paint("https://evil/x.png"))).toContain("none");
	expect(pageChromeCss(paint("https://evil/x.png"))).not.toContain("evil");
});

test("theme photos reject wrong magic, oversize, huge frames, and a gif polyglot", () => {
	expect(acceptThemePhoto(PNG_1X1).ok).toBe(true);
	expect(acceptThemePhoto(Buffer.from("<html><script>alert(1)</script>")).ok).toBe(false);
	expect(acceptThemePhoto(gif()).ok).toBe(true);
	const poly = gif({ extra: "</html><script>alert(1)</script>" });
	const polyGot = acceptThemePhoto(poly);
	expect(polyGot.ok).toBe(false);
	if (!polyGot.ok) expect(polyGot.message).not.toContain("script");
	const huge = gif({ width: 4097, height: 4097 });
	expect(acceptThemePhoto(huge).ok).toBe(false);
	const fat = Buffer.concat([PNG_1X1, Buffer.alloc(8 * 1024 * 1024)]);
	expect(acceptThemePhoto(fat).ok).toBe(false);
});
