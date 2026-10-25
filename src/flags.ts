// Flags people can pick at sign-up; they show next to the name, in the place X
// puts an affiliate's organisation badge, served as /public/flag-<id>.svg.
// Pride flags are meowcord's badge drawings (AGPL-3.0,
// github.com/meowcorded/meowcord; some of them after Twemoji), kept in
// public/flags/pride. Country flags are Twemoji's (CC-BY 4.0, by Twitter), the
// client's own emoji images, saved in public/flags.

import { join } from "node:path";

type Flag = { name: string; country?: string };

// id: name. The ids are what accounts wear (users.flag), so they stay put.
const PRIDE: Record<string, Flag> = Object.fromEntries(
	Object.entries({
		pride: "Pride",
		progress: "Progress Pride",
		trans: "Transgender",
		bi: "Bisexual",
		pan: "Pansexual",
		lesbian: "Lesbian",
		gay: "Gay",
		nonbinary: "Non-binary",
		genderfluid: "Genderfluid",
		agender: "Agender",
		asexual: "Asexual",
		aromantic: "Aromantic",
		intersex: "Intersex",
		genderqueer: "Genderqueer",
		bigender: "Bigender",
		pangender: "Pangender",
		neutrois: "Neutrois",
		androgyne: "Androgyne",
		polysexual: "Polysexual",
		omnisexual: "Omnisexual",
		abrosexual: "Abrosexual",
		aroace: "Aroace (sunset)",
		demisexual: "Demisexual",
		demiromantic: "Demiromantic",
		abroromantic: "Abroromantic",
		aceflux: "Aceflux",
		achillean: "Achillean",
		ambiamorous: "Ambiamorous",
		androromantic: "Androromantic",
		androsexual: "Androsexual",
		aporagender: "Aporagender",
		aroflux: "Aroflux",
		aspec: "Aspec",
		biromantic: "Biromantic",
		ceres: "Ceres",
		ceteroromantic: "Ceteroromantic",
		ceterosexual: "Ceterosexual",
		demiboy: "Demiboy",
		demifluid: "Demifluid",
		demiflux: "Demiflux",
		demigender: "Demigender",
		demigirl: "Demigirl",
		diamoric: "Diamoric",
		egogender: "Egogender",
		femboy: "Femboy",
		frayromantic: "Frayromantic",
		gayfive: "Gay men (five stripes)",
		genderflux: "Genderflux",
		genderqueersymbol: "Genderqueer (symbol)",
		genderneutral: "Gender neutral",
		genderquestioning: "Gender questioning",
		graygender: "Graygender",
		grayromantic: "Grayromantic",
		grayasexual: "Gray-asexual",
		gyneromantic: "Gyneromantic",
		gynesexual: "Gynesexual",
		hijra: "Hijra",
		intergender: "Intergender",
		intersexprogress: "Intersex-inclusive Progress",
		lesbianfive: "Lesbian (five stripes)",
		maverique: "Maverique",
		mogai: "MOGAI",
		multigender: "Multigender",
		multisexual: "Multisexual",
		neurogender: "Neurogender",
		omniromantic: "Omniromantic",
		originalrainbow: "Original rainbow (eight stripes)",
		panromantic: "Panromantic",
		philadelphia: "Philadelphia",
		polyamory: "Polyamory",
		polyamoryalt: "Polyamory (alternative)",
		polygender: "Polygender",
		polyromantic: "Polyromantic",
		pomosexual: "Pomosexual",
		queer: "Queer",
		sapphic: "Sapphic",
		straightally: "Straight ally",
		transfeminine: "Transfeminine",
		transmasculine: "Transmasculine",
		transneutral: "Transneutral",
		trigender: "Trigender",
		twospirit: "Two-spirit",
		unlabeled: "Unlabeled",
		waria: "Waria",
		xenogender: "Xenogender",
	}).map(([id, name]) => [id, { name }]),
);

// every ISO 3166-1 country and territory with a flag emoji, and the EU, UN and
// Kosovo; IL, KP and RU are left out on purpose (the instance's call)
const COUNTRY_CODES =
	"AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET EU FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM UN US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW";
const regionName = new Intl.DisplayNames(["en"], { type: "region" });
// "country-" keeps them apart from the pride flags (Burundi is "bi", like Bisexual)
const COUNTRIES: Record<string, Flag> = Object.fromEntries(
	COUNTRY_CODES.split(" ")
		.map((code) => [`country-${code.toLowerCase()}`, { name: regionName.of(code) ?? code, country: code }] as const)
		.sort((a, b) => a[1].name.localeCompare(b[1].name, "en")),
);

export const FLAGS: Record<string, Flag> = { ...PRIDE, ...COUNTRIES };

export const isFlag = (id: unknown): id is string => typeof id === "string" && Object.hasOwn(FLAGS, id);

export const MAX_FLAGS = 4;
export const flagList = (v: unknown): string[] => (typeof v === "string" ? [...new Set(v.split(",").map((f) => f.trim()))].filter(isFlag).slice(0, MAX_FLAGS) : []);
export const flagValue = (v: unknown): string | null => flagList(v).join(",") || null;
export const unknownFlag = (v: unknown) => typeof v === "string" && v.split(",").some((f) => f.trim() && !isFlag(f.trim()));

// a country's emoji image is public/flags/<code>.svg, a pride flag's badge
// public/flags/pride/<id>.svg
const FLAG_DIR = join(import.meta.dir, "..", "public", "flags");

export async function flagSvg(id: string): Promise<string | undefined> {
	const f = FLAGS[id];
	if (!f) return undefined;
	const file = Bun.file(join(FLAG_DIR, f.country ? `${f.country.toLowerCase()}.svg` : `pride/${id}.svg`));
	return (await file.exists()) ? file.text() : undefined;
}
