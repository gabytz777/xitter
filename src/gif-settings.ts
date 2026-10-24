import { accountPage, esc } from "./account-page";
import type { Viewer } from "./auth";
import { sql } from "./db";
import { gifProviderPreference, gifProviders } from "./gifs";

async function page(req: Request, viewer: Viewer, error = "") {
    const choices = gifProviders();
    const selected = await gifProviderPreference(viewer.id);
    const options = [
        `<option value="auto"${selected === "auto" ? " selected" : ""}>Automatic</option>`,
        ...choices.map(({ id, display_name }) => `<option value="${esc(id)}"${selected === id ? " selected" : ""}>${esc(display_name)}</option>`),
    ].join("");
    return accountPage({
        req,
        viewer,
        title: "GIF provider",
        status: error ? 400 : 200,
        body: `<h1>GIF provider</h1>
<p class="dim">Choose which provider supplies your GIF search and trending results. Automatic uses this instance's default.</p>
${error ? `<p class="error" role="alert">${esc(error)}</p>` : ""}
<form method="post" action="/account/gifs">
<input type="hidden" name="csrf" value="${esc(viewer.csrf)}">
<label for="provider">Provider</label>
<select id="provider" name="provider">${options}</select>
<button type="submit">Save provider</button>
</form>`,
    });
}

export async function gifSettingsRoute(req: Request, viewer: Viewer): Promise<Response> {
    if (req.method !== "POST") return page(req, viewer);
    const form = await req.formData().catch(() => undefined);
    if (String(form?.get("csrf") ?? "") !== viewer.csrf) return page(req, viewer, "That form is out of date. Try again.");
    const provider = String(form?.get("provider") ?? "");
    if (provider !== "auto" && !gifProviders().some((choice) => choice.id === provider))
        return page(req, viewer, "Choose a provider available on this instance.");
    await sql`update users set preferences = jsonb_set(coalesce(preferences, '{}'), '{gif_provider}', to_jsonb(${provider}::text), true) where id = ${viewer.id}::bigint`;
    return new Response(null, { status: 303, headers: { location: "/account/gifs" } });
}