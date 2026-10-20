// A readable, self-contained companion to the machine-readable JSON archive.
// No scripts, remote assets, or links to private live endpoints are needed.
const esc = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
	"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[char]!);

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const label = (key: string) => key.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase());
const date = (value: unknown) => typeof value === "string" && /^\d{4}-\d\d-\d\d/.test(value) ? value.replace("T", " ").replace(/\.\d+Z$/, " UTC") : value;

function fields(value: unknown): string {
	return Object.entries(object(value)).map(([key, item]) => {
		const shown = item && typeof item === "object" ? JSON.stringify(item, null, 2) : date(item);
		return `<dt>${esc(label(key))}</dt><dd>${esc(shown)}</dd>`;
	}).join("");
}

function section(key: string, value: unknown): string {
	const entries = Array.isArray(value) ? value : [value];
	const title = label(key);
	return `<section id="${esc(key)}"><h2>${esc(title)} <small>${Array.isArray(value) ? entries.length : ""}</small></h2>
${entries.length ? entries.map((item, index) => {
		const row = object(item);
		const preview = key === "posts" ? row.text : key === "drafts" || key === "scheduled_posts" ? object(row.request).status : row.name ?? row.screen_name ?? row.id ?? `${title} ${index + 1}`;
		return `<details${index < 3 ? " open" : ""}><summary>${esc(preview || `${title} ${index + 1}`)}</summary><dl>${fields(item)}</dl></details>`;
	}).join("") : `<p class="empty">No ${esc(title.toLowerCase())} in this archive.</p>`}</section>`;
}

export function exportHtml(archive: Record<string, unknown>): string {
	const account = object(archive.account);
	const sections = Object.entries(archive).filter(([key]) => key !== "generated_at");
	return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(account.screen_name ?? "Account")} · Xitter archive</title>
<style>html{scroll-behavior:smooth}body{margin:0;background:#f7f8fa;color:#17202a;font:16px/1.5 system-ui,sans-serif}header{background:#15202b;color:white;padding:28px max(24px,calc((100vw - 1100px)/2))}h1{margin:0;font-size:2rem}header p{margin:8px 0 0;color:#cbd5df}.layout{max-width:1100px;margin:auto;display:grid;grid-template-columns:220px minmax(0,1fr);gap:32px;padding:24px}nav{position:sticky;top:20px;align-self:start;max-height:calc(100vh - 40px);overflow:auto}nav a{display:block;padding:5px 8px;color:#175a91;text-decoration:none}nav a:hover{text-decoration:underline}main{min-width:0}section{margin-bottom:30px}h2{border-bottom:1px solid #d4dce4;padding-bottom:8px}small{color:#657786;font-size:.7em}details{background:white;border:1px solid #d4dce4;border-radius:8px;margin:9px 0;padding:10px 14px}summary{cursor:pointer;font-weight:600;overflow-wrap:anywhere}dl{display:grid;grid-template-columns:minmax(110px,170px) minmax(0,1fr);gap:8px;margin:15px 0 0}dt{color:#657786}dd{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}.empty{color:#657786}@media(max-width:700px){.layout{display:block}nav{position:static;columns:2}dl{display:block}dt{margin-top:10px}}</style>
<header><h1>Your Xitter archive</h1><p>@${esc(account.screen_name ?? "account")} · generated ${esc(date(archive.generated_at))}</p><p>This file works offline. Chat messages remain encrypted; this archive does not contain decryption keys or uploaded media files.</p></header>
<div class="layout"><nav aria-label="Archive sections">${sections.map(([key, value]) => `<a href="#${esc(key)}">${esc(label(key))}${Array.isArray(value) ? ` (${value.length})` : ""}</a>`).join("")}</nav><main>${sections.map(([key, value]) => section(key, value)).join("")}</main></div></html>`;
}
