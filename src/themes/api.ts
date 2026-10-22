// themeApi, import/export HTTP handlers, load/save look, nightModeCookies, DB access.

import type { Viewer } from "../auth";
import { prepareFonts } from "../fonts";
import { resolveBackgroundItem, steamDefId, steamStillPath, steamVideoPath, type SteamDefId, type StoredSteam } from "../steam-items";
import { PRESETS, accentWire, type Accent, type Theme } from "./presets";
import {
	NIGHT_MODE_ATTR,
	STEAM_MISSING,
	THEME_FILE_MAX,
	applyWrite,
	copyTheme,
	exportTheme,
	finishBackground,
	importTheme,
	lookView,
	modeOf,
	backgroundKnobs,
	overlayAccent,
	parseLookWrite,
	readPrefs,
	themeFileName,
	type ImportedTheme,
	type Look,
	type LookWrite,
	type Prefs,
	type ThemeError,
} from "./validate";

export async function themeImport(req: Request, _viewer: Viewer): Promise<Response> {
	if (req.method !== "POST") return Response.json({ ok: false, errors: [{ path: "", message: "use POST" }] }, { status: 405 });
	const announced = Number(req.headers.get("content-length"));
	if (Number.isFinite(announced) && announced > THEME_FILE_MAX) return Response.json({ ok: false, errors: [{ path: "", message: "file is too large" }] }, { status: 400 });
	const result = await importResolvedTheme(await req.text());
	if (!result.ok) return Response.json({ ok: false, errors: result.errors }, { status: 400 });
	return Response.json(result.preview ? { ok: true, theme: result.theme, warnings: result.warnings, preview: result.preview } : { ok: true, theme: result.theme, warnings: result.warnings });
}

export type SteamPreview = { readonly image: string; readonly movie: string | null; readonly mp4: string | null };

export async function importResolvedTheme(
	text: string,
	resolve: (defid: SteamDefId) => Promise<StoredSteam | undefined> = resolveBackgroundItem,
): Promise<{ ok: true; theme: ImportedTheme; warnings: readonly string[]; preview?: SteamPreview } | { ok: false; errors: readonly ThemeError[] }> {
	const parsed = importTheme(text);
	if (!parsed.ok) return parsed;
	const wire = parsed.theme.background?.steam?.defid;
	if (wire === undefined) return parsed;
	const defid = steamDefId(wire);
	const item = defid ? await resolve(defid).catch(() => undefined) : undefined;
	if (!item) return { ok: false, errors: [{ path: "theme.background.steam", message: STEAM_MISSING }] };
	return {
		ok: true,
		theme: parsed.theme,
		warnings: parsed.warnings,
		preview: { image: steamStillPath(item), movie: steamVideoPath(item, "movie"), mp4: steamVideoPath(item, "mp4") },
	};
}

export async function themeExport(req: Request, viewer: Viewer): Promise<Response> {
	if (req.method !== "GET") return Response.json({ ok: false, errors: [{ path: "", message: "use GET" }] }, { status: 405 });
	const prefs = await loadPrefs(viewer.id);
	const theme = prefs.look?.kind === "painted" ? prefs.look.theme : null;
	if (!theme) return Response.json({ ok: false, errors: [{ path: "theme", message: "no saved theme" }] }, { status: 404 });
	const file = exportTheme(theme);
	return new Response(JSON.stringify(file), {
		headers: {
			"content-type": "application/json; charset=utf-8",
			"content-disposition": `attachment; filename="${themeFileName(theme)}"`,
		},
	});
}

export function nightModeCookies(look: Look | null): readonly string[] {
	if (!look) return [];
	return [`night_mode=${modeOf(look) === "light" ? "0" : "2"}; ${NIGHT_MODE_ATTR}`];
}

async function keepOwnedBackground(userId: string, theme: Theme, warnings: string[]): Promise<Theme> {
	const id = theme.background?.mediaId;
	if (!id) return theme;
	const { ownedThemePhoto } = await import("../media");
	const owned = await ownedThemePhoto(userId, id);
	if (owned) return theme;
	warnings.push("that background image isn't on this account");
	const next = copyTheme(theme);
	next.background = backgroundKnobs(theme.background!);
	return next;
}

export async function commitLook(
	userId: string,
	current: Prefs,
	write: LookWrite,
	accent: Accent | undefined,
	warnings: readonly string[] = [],
	resolve: (defid: SteamDefId) => Promise<StoredSteam | undefined> = resolveBackgroundItem,
): Promise<{ ok: true; look: Look | null; accent: Accent; warnings: readonly string[] } | { ok: false; error: typeof STEAM_MISSING }> {
	const nextWarnings = [...warnings];
	const nextAccent = accent ?? current.accent;
	let look: Look | null;
	if (write.type === "paint") {
		const stored = current.look?.kind === "painted" ? current.look.theme : undefined;
		let resolved: StoredSteam | undefined;
		if (write.source.tag === "steam" && write.peel === "frame" && !PRESETS[write.theme.id]) {
			const prev = stored?.background?.steam;
			if (prev && prev.defid === write.source.defid) resolved = prev;
			else resolved = await resolve(write.source.defid).catch(() => undefined);
		}
		const finished = finishBackground(stored, write.theme, write.peel, write.source, resolved);
		if (!finished.ok) return { ok: false, error: finished.error };
		let theme = await keepOwnedBackground(userId, finished.theme, nextWarnings);
		if (theme.font) {
			const prep = await prepareFonts(theme.font);
			nextWarnings.push(...prep.warnings);
			if (prep.font.ui || prep.font.display) theme = { ...theme, font: prep.font };
			else {
				theme = { ...theme };
				delete theme.font;
			}
		}
		look = overlayAccent({ kind: "painted", theme }, nextAccent);
	} else look = overlayAccent(applyWrite(current.look, write), nextAccent);
	await saveLook(userId, look, nextAccent);
	return { ok: true, look, accent: nextAccent, warnings: nextWarnings };
}

async function saveLook(userId: string, look: Look | null, accent: Accent): Promise<void> {
	const { sql } = await import("../db");
	const patch =
		look?.kind === "native"
			? { mode: look.mode, accent: accentWire(accent) }
			: look?.kind === "painted"
				? { theme: look.theme, accent: accentWire(accent) }
				: { accent: accentWire(accent) };
	await sql`update users set preferences = (coalesce(preferences, '{}') - 'theme' - 'mode' - 'accent') || ${JSON.stringify(patch)}::text::jsonb where id = ${userId}::bigint`;
}

export async function loadPrefs(userId: string): Promise<Prefs> {
	const { sql } = await import("../db");
	const [row] = await sql`select preferences from users where id = ${userId}::bigint`;
	return readPrefs(row?.preferences);
}

export async function loadLook(userId: string): Promise<Look | null> {
	return (await loadPrefs(userId)).look;
}

export async function themeApi(req: Request, viewer: Viewer): Promise<Response> {
	if (req.method === "GET") {
		const prefs = await loadPrefs(viewer.id);
		return Response.json(lookView(prefs.look, prefs.accent));
	}
	if (req.method !== "POST") return Response.json({ error: "use GET or POST" }, { status: 405 });
	const body = await req.json().catch(() => null);
	const current = await loadPrefs(viewer.id);
	const parsed = parseLookWrite(body);
	if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
	const saved = await commitLook(viewer.id, current, parsed.write, parsed.accent, parsed.warnings);
	if (!saved.ok) return Response.json({ error: saved.error }, { status: 400 });
	const headers = new Headers();
	for (const c of nightModeCookies(saved.look)) headers.append("set-cookie", c);
	const view = lookView(saved.look, saved.accent);
	if (parsed.write.type === "paint" || saved.warnings.length) return Response.json({ ...view, warnings: saved.warnings }, { headers });
	return Response.json(view, { headers });
}
