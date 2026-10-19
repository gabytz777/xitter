import { FEDERATION_ON, INSTANCE_ID, keyFor, loadRegistry, refreshRegistry, verifyIncoming, wellKnown } from "./federation";
import { federationApi, startFederationSync } from "./federation-sync";
import { hit, limitedResponse } from "./ratelimit";
import { emergencyApi, pollEmergencies } from "./superadmin";
import { SUPERADMINS } from "./superadmins";

export async function federationRoute(req: Request, url: URL): Promise<Response | undefined> {
	const p = url.pathname;
	if (p === "/.well-known/xitter") return wellKnown();
	if (!p.startsWith("/federation/v1/")) return undefined;
	const path = `${p}${url.search}`;
	const incoming = await verifyIncoming(req, path, { allowSuperadminHome: p === "/federation/v1/emergency" });
	if (incoming instanceof Response) return incoming;
	const h = hit("federation", incoming.from);
	if (!h.ok) return limitedResponse(h);
	return (await emergencyApi(incoming, req.method, p)) ?? federationApi(incoming, req.method, p, url);
}

export async function startFederation() {
	await loadRegistry();
	if (!FEDERATION_ON) return;
	void refreshRegistry();
	setInterval(() => void refreshRegistry(), 5 * 60_000).unref();
	startFederationSync();
	const meetHomes = () => Promise.all([...new Set(SUPERADMINS.map((s) => s.instance))].filter((i) => i !== INSTANCE_ID).map((i) => keyFor(i).catch(() => undefined)));
	void meetHomes();
	setInterval(() => void meetHomes(), 10 * 60_000).unref();
	setInterval(() => void pollEmergencies().catch(() => {}), 60_000).unref();
}
