// Turns maintenance mode on or off from the command line, using the same
// settings path the admin panel writes, so the running app picks it up at once.
//
//   docker compose exec -T app bun scripts/maintenance.ts on "Back soon: moving to a new home."
//   docker compose exec -T app bun scripts/maintenance.ts off

import { allSettings, setSetting } from "../src/settings";

const [mode, ...rest] = process.argv.slice(2);
const message = rest.join(" ").trim();

if (mode === "on") {
	const current = await allSettings();
	await setSetting("operations", { ...current.operations, maintenance: true, ...(message ? { message } : {}) });
	console.log(`maintenance on: ${(await allSettings()).operations.message}`);
} else if (mode === "off") {
	const current = await allSettings();
	await setSetting("operations", { ...current.operations, maintenance: false });
	console.log("maintenance off");
} else {
	const current = await allSettings();
	console.log(JSON.stringify(current.operations, null, 2));
}