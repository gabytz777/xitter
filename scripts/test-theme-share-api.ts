import { sql } from "../src/db";

const [name = "coah", password = "testpass123"] = process.argv.slice(2);
const origin = `http://localhost:${process.env.PORT ?? 3000}`;
let failed = 0;
const check = (ok: unknown, what: string, detail?: unknown) => {
	console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail === undefined || ok ? "" : `: ${JSON.stringify(detail).slice(0, 300)}`}`);
	if (!ok) failed++;
};

const theme = {
	id: "custom",
	base: "dark",
	bg: { stops: ["#0a0a12", "#180828"], angle: 120 },
	surface: "#121018",
	text: "#f2f0ff",
	accent: "#8b7cff",
	button: { stops: ["#eef0ff", "#ffffff"], angle: 180 },
	buttonText: "#070b1a",
};

const fileOf = (body: unknown) => JSON.stringify({ format: "xitter-theme", version: 1, theme: body });

const login = await fetch(`${origin}/login`, { method: "POST", body: new URLSearchParams({ username: name, password }), redirect: "manual" });
const cookies = login.headers.getSetCookie().map((c) => c.split(";")[0]);
const csrf = cookies.find((c) => c.startsWith("ct0="))!.slice(4);
const cookie = cookies.join("; ");
const headers = { cookie, "x-csrf-token": csrf };
const [before] = await sql`select preferences from users where lower(screen_name) = lower(${name})`;

try {
	await fetch(`${origin}/i/api/xitter/theme`, {
		method: "POST",
		headers: { ...headers, "content-type": "application/json" },
		body: JSON.stringify({
			theme: { ...theme, background: { fit: "cover", position: "center", dim: 20, blur: 4, mediaId: "1" } },
		}),
	});

	const exported = await fetch(`${origin}/i/api/xitter/theme/export`, { headers });
	const exportedText = await exported.text();
	check(exported.ok && (exported.headers.get("content-disposition") ?? "").includes(".xitter-theme.json"), "export downloads a theme file", exported.status);
	check(exportedText.includes('"format":"xitter-theme"') && !exportedText.includes("mediaId") && !exportedText.includes("/media/"), "export omits the image");

	const imported = await fetch(`${origin}/i/api/xitter/theme/import`, {
		method: "POST",
		headers: { ...headers, "content-type": "text/plain" },
		body: exportedText,
	}).then((r) => r.json() as Promise<{ ok?: boolean; theme?: { id?: string }; warnings?: string[] }>);
	check(imported.ok && imported.theme?.id === "custom" && (imported.warnings ?? []).some((w) => /background image not included/.test(w)), "import previews and warns about the image");

	const attacks = [
		fileOf({ ...theme, text: "#fff;}body{display:none" }),
		'{"format":"xitter-theme","version":1,"__proto__":{"x":1},"theme":{"id":"custom"}}',
		`{"format":"xitter-theme","version":1,"theme":{"pad":"${"a".repeat(70_000)}"}}`,
		fileOf({ ...theme, extra: true }),
		fileOf({ ...theme, font: { ui: "../../etc" } }),
		fileOf({ ...theme, background: { url: "https://evil.example/x.gif" } }),
	];
	for (const body of attacks) {
		const r = await fetch(`${origin}/i/api/xitter/theme/import`, {
			method: "POST",
			headers: { ...headers, "content-type": "text/plain" },
			body,
		});
		const data = await r.json();
		const blob = JSON.stringify(data);
		check(r.status === 400 && data.ok === false && Array.isArray(data.errors), `live import rejects ${body.slice(0, 32)}`);
		check(!blob.includes("display:none") && !blob.includes("evil.example"), "rejected import has no attack string");
	}

	const page = await fetch(`${origin}/account/theme`, { headers: { cookie } });
	const html = await page.text();
	check(html.includes("Export theme") && html.includes("Import theme") && html.includes("theme-file"), "editor has share controls");
} finally {
	await sql`update users set preferences = ${JSON.stringify(before?.preferences ?? {})}::text::jsonb where lower(screen_name) = lower(${name})`;
}

console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
