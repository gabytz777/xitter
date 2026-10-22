import puppeteer from "/workspace/xitterbadge/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js";
import { readFileSync } from "node:fs";

const origin = `http://localhost:${process.env.PORT ?? 3000}`;
const [token, ct0, userId] = readFileSync("/tmp/xsess", "utf8").trim().split(/\s+/);
if (!token || !ct0 || !userId) throw new Error("need /tmp/xsess: auth_token ct0 userId");

type Hit = { page: string; sel: string; prop: string; value: string; testid: string };
const hits: Hit[] = [];

const browser = await puppeteer.launch({
	executablePath: "/usr/bin/google-chrome",
	headless: true,
	args: ["--no-sandbox", "--disable-gpu", "--window-size=1280,900"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });
await page.setCookie(
	{ name: "auth_token", value: token, domain: "localhost", path: "/" },
	{ name: "ct0", value: ct0, domain: "localhost", path: "/" },
	{ name: "twid", value: `u%3D${userId}`, domain: "localhost", path: "/" },
);
const go = async (url: string) => {
	await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 }).catch(() =>
		page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 }),
	);
};

const setAccent = async (body: unknown) => {
	const r = await page.evaluate(async (payload, csrf) => {
		const res = await fetch("/i/api/xitter/theme", {
			method: "POST",
			credentials: "same-origin",
			headers: { "content-type": "application/json", "x-csrf-token": csrf },
			body: JSON.stringify(payload),
		});
		return { ok: res.ok, d: await res.json() };
	}, body, ct0);
	if (!r.ok) throw new Error(`accent post failed ${JSON.stringify(r.d)}`);
};

const scan = async (label: string) => {
	const found = await page.evaluate(() => {
		const props = ["color", "backgroundColor", "borderColor", "outlineColor", "fill", "stroke", "accentColor", "boxShadow", "backgroundImage"] as const;
		const parse = (v: string) => {
			const out: { r: number; g: number; b: number; a: number }[] = [];
			const re = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([0-9.]+))?\)/g;
			let m: RegExpExecArray | null;
			while ((m = re.exec(v))) out.push({ r: +m[1], g: +m[2], b: +m[3], a: m[4] == null ? 1 : +m[4] });
			return out;
		};
		const isTint = (v: string) => {
			if (/#1[dD]9[bB][fF]0|#1[aA]8[cC][dD]8/i.test(v)) return true;
			return parse(v).some((c) => {
				if (c.a === 0) return false;
				const r = c.r / 255,
					g = c.g / 255,
					b = c.b / 255;
				const max = Math.max(r, g, b),
					min = Math.min(r, g, b),
					d = max - min;
				const l = (max + min) / 2;
				const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
				if (s < 0.25 || l < 0.18 || l > 0.95) return false;
				let h = 0;
				if (d !== 0) {
					if (max === r) h = ((g - b) / d) % 6;
					else if (max === g) h = (b - r) / d + 2;
					else h = (r - g) / d + 4;
					h *= 60;
					if (h < 0) h += 360;
				}
				let dh = Math.abs(h - 204);
				if (dh > 180) dh = 360 - dh;
				return dh <= 18;
			});
		};
		const out: { sel: string; prop: string; value: string; testid: string }[] = [];
		const all = document.querySelectorAll("body *");
		for (const el of all) {
			if (!(el instanceof HTMLElement) && !(el instanceof SVGElement)) continue;
			if (el.closest("[data-xitter-badges],[data-xitter-frame],[data-xitter-framed],[data-xitter-decor-bg],.xitter-deco,[aria-label=\"Color options\"],html[data-xitter-decor] body")) continue;
			const goldSvg = el.closest("svg[data-testid=\"icon-verified\"]");
			if (goldSvg && goldSvg.querySelector("linearGradient,stop")) continue;
			if (goldSvg) {
				const fl = getComputedStyle(goldSvg).fill + getComputedStyle(goldSvg).color;
				if (/130, 154, 171|226, 183, 25|212, 167, 44/.test(fl)) continue;
			}
			const cs = getComputedStyle(el);
			for (const prop of props) {
				const value = (cs as unknown as Record<string, string>)[prop];
				if (!value || value === "none" || value === "rgba(0, 0, 0, 0)" || value === "transparent") continue;
				if (!isTint(value)) continue;
				const testid = el.getAttribute("data-testid") || el.closest("[data-testid]")?.getAttribute("data-testid") || el.getAttribute("aria-label") || "";
				out.push({
					sel: `${el.tagName.toLowerCase()}${testid ? `[${testid}]` : ""}`,
					prop,
					value: value.slice(0, 80),
					testid,
				});
			}
		}
		for (const svg of document.querySelectorAll('svg[data-testid="icon-verified"]')) {
			const cs = getComputedStyle(svg);
			const painted = /255,\s*61,\s*127|#ff3d7f/i.test(cs.fill + cs.color + (svg.getAttribute("style") || ""));
			if (svg.querySelector("linearGradient,stop") && painted) {
				out.push({ sel: "svg[data-testid=icon-verified]", prop: "gold", value: cs.fill, testid: "gold-check-painted" });
			}
			if (/130,\s*154,\s*171/.test(cs.fill + [...svg.querySelectorAll("*")].map((n) => n.getAttribute("stop-color") || "").join(" ")) === false) {
				const greyish = [...svg.querySelectorAll("*")].some((n) => /829aab|130,\s*154,\s*171/i.test(getComputedStyle(n).fill + (n.getAttribute("fill") || "")));
				if ((greyish || /government/i.test(svg.closest("article,div")?.textContent || "")) && painted) {
					out.push({ sel: "svg[data-testid=icon-verified]", prop: "grey", value: cs.fill, testid: "grey-check-painted" });
				}
			}
		}
		const slider = document.querySelector('[role="slider"][aria-label="Text size"]');
		if (slider) {
			const host = slider.closest('[aria-label="Section details"]') || slider.parentElement;
			if (host) {
				for (const el of host.querySelectorAll("*")) {
					if (!(el instanceof HTMLElement)) continue;
					const bg = getComputedStyle(el).backgroundColor;
					if (isTint(bg)) out.push({ sel: "slider", prop: "backgroundColor", value: bg, testid: "Text size" });
				}
			}
		}
		const post = document.querySelector('[data-testid="tweetButtonInline"],[data-testid="tweetButton"]') as HTMLButtonElement | null;
		if (post && (post.disabled || post.getAttribute("aria-disabled") === "true")) {
			const cs = getComputedStyle(post);
			const painted = `${cs.backgroundColor} ${cs.backgroundImage}`;
			if (!isTint(painted) && !/255,\s*61,\s*127|#ff3d7f|linear-gradient/i.test(painted)) {
				out.push({ sel: "button[tweetButton]", prop: "backgroundColor", value: painted.slice(0, 80), testid: "disabled-post" });
			}
		}
		return out.slice(0, 80);
	});
	for (const h of found) hits.push({ page: label, ...h });
};

const hover = async (label: string) => {
	const name = await page.$('[data-testid="User-Name"] a, [data-testid="UserName"] a, [data-testid="UserName"]');
	if (!name) return;
	const box = await name.boundingBox();
	if (!box) return;
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	await new Promise((r) => setTimeout(r, 1200));
	await scan(`${label} hover-card`);
};

const paths = ["/home", "/explore", "/notifications", "/settings/display", "/coah", "/NintendoEurope", "/justparody", "/parodybot", "/compose/post"];

await go(`${origin}/home`);
await setAccent({ mode: "dark", accent: "#ff3d7f" });
await page.reload({ waitUntil: "networkidle2", timeout: 60000 }).catch(() =>
	page.reload({ waitUntil: "domcontentloaded", timeout: 60000 }),
);

for (const p of paths) {
	await go(`${origin}${p}`);
	await new Promise((r) => setTimeout(r, 1500));
	if (p === "/home") {
		const post = await page.$('a[href*="/status/"]');
		if (post) {
			const href = await page.evaluate((el) => (el as HTMLAnchorElement).href, post);
			await scan(p);
			if (href) {
				await go(href).catch(() => {});
				await new Promise((r) => setTimeout(r, 1200));
				await scan("post");
			}
			continue;
		}
	}
	if (p === "/coah" || p === "/justparody" || p === "/NintendoEurope" || p === "/parodybot") await hover(p);
	await scan(p);
}

await setAccent({ accent: { stops: ["#ff3d7f", "#7856ff"], angle: 90 } });
await go(`${origin}/home`);
await new Promise((r) => setTimeout(r, 1500));
await scan("home-gradient");

await browser.close();

if (!hits.length) {
	console.log("scan: no leftover X blue on walked pages");
	process.exit(0);
}
console.log(`scan: ${hits.length} leftover X blue hits`);
for (const h of hits.slice(0, 40)) console.log(`  ${h.page} ${h.prop}=${h.value} ${h.sel} ${h.testid}`);
process.exit(1);
