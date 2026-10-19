import { PUBLIC_ORIGIN } from "./config";

export type Superadmin = { readonly instance: string; readonly screen_name: string; readonly user_id: string | null; readonly instance_key: string | null };

const HARDCODED: readonly Superadmin[] = [
	{ instance: "xitter.opuadm.com", screen_name: "meow", user_id: null, instance_key: null },
	{ instance: "xit.chococat.lol", screen_name: "pozo", user_id: null, instance_key: "C_9Cz5GkJjtSvWngLyVhfSTscLdcYo6Omx_EpSzQU5w" },
	{ instance: "xit.chococat.lol", screen_name: "tiago", user_id: null, instance_key: "C_9Cz5GkJjtSvWngLyVhfSTscLdcYo6Omx_EpSzQU5w" },
];

const testing = process.env.FEDERATION_ALLOW_HTTP && process.env.XITTER_TEST_SUPERADMINS;

export const SUPERADMINS: readonly Superadmin[] = Object.freeze(
	(testing
		? String(testing)
				.split(",")
				.map((s) => {
					const [screen_name, instance] = s.trim().split("@");
					return { instance, screen_name, user_id: null, instance_key: null };
				})
		: HARDCODED
	).map((s) => Object.freeze({ ...s })),
);

export const isSuperadminHome = (instance: string) => SUPERADMINS.some((s) => s.instance === instance);

export const superadminOf = (instance: string, screenName: string, userId?: string) =>
	SUPERADMINS.find((s) => s.instance === instance && s.screen_name.toLowerCase() === screenName.toLowerCase() && (userId === undefined || !s.user_id || s.user_id === userId));

const HERE = new URL(PUBLIC_ORIGIN).host.toLowerCase();

export const superadminNameHere = (screenName: string) => !!superadminOf(HERE, screenName);

export const pinnedHomeKey = (instance: string) => SUPERADMINS.find((s) => s.instance === instance && s.instance_key)?.instance_key ?? undefined;
