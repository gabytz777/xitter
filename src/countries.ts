// Where an account is based, for "About this account": the country comes from
// the edge's CF-IPCountry header (set when the site sits behind Cloudflare),
// the region is the continent that country is on.
const CONTINENTS: Record<string, string> = {
	Africa:
		"DZ AO BJ BW BF BI CM CV CF TD KM CG CD CI DJ EG GQ ER SZ ET GA GM GH GN GW KE LS LR LY MG MW ML MR MU YT MA MZ NA NE NG RE RW ST SN SC SL SO ZA SS SD TZ TG TN UG EH ZM ZW",
	Asia:
		"AF AM AZ BH BD BT BN KH CN GE HK IN ID IR IQ IL JP JO KZ KW KG LA LB MO MY MV MN MM NP KP OM PK PS PH QA SA SG KR LK SY TW TJ TH TL TR TM AE UZ VN YE CY",
	Europe:
		"AL AD AT BY BE BA BG HR CZ DK EE FO FI FR DE GI GR HU IS IE IM IT XK LV LI LT LU MT MD MC ME NL MK NO PL PT RO RU SM RS SK SI ES SE CH UA GB VA AX GG JE",
	"North America":
		"AG BS BB BZ CA CR CU DM DO SV GL GD GT HT HN JM MX NI PA KN LC VC TT US PR VI KY BM AW CW AI MS TC VG",
	"South America": "AR BO BR CL CO EC GY PY PE SR UY VE FK GF",
	Oceania: "AU FJ KI MH FM NR NZ PW PG WS SB TO TV VU NC PF GU",
};

const REGION_OF = new Map<string, string>(Object.entries(CONTINENTS).flatMap(([name, codes]) => codes.split(" ").map((c): [string, string] => [c, name])));
const NAMES = new Intl.DisplayNames(["en"], { type: "region" });

// the header's value if it is a real two-letter code (XX and T1 mean unknown / Tor)
export function countryFromHeader(value: string | null): string | undefined {
	const code = value?.trim().toUpperCase();
	return code && /^[A-Z]{2}$/.test(code) && code !== "XX" && code !== "T1" ? code : undefined;
}

export function countryName(code: string): string | undefined {
	try {
		const name = NAMES.of(code);
		return name && name !== code ? name : undefined;
	} catch {
		return undefined;
	}
}

export const regionName = (code: string): string | undefined => REGION_OF.get(code);

// a two-letter code, or a country's English name ("sweden"), as its code
export function countryCode(input: string): string | undefined {
	const value = input.trim();
	if (/^[a-zA-Z]{2}$/.test(value) && countryName(value.toUpperCase())) return value.toUpperCase();
	const wanted = value.toLowerCase();
	for (const code of REGION_OF.keys()) if (countryName(code)?.toLowerCase() === wanted) return code;
	return undefined;
}

// every country a trend location can be, by name
export const allCountries = (): { code: string; name: string }[] =>
	[...REGION_OF.keys()].flatMap((code) => (countryName(code) ? [{ code, name: countryName(code)! }] : [])).sort((a, b) => a.name.localeCompare(b.name));

export const isCountry = (code: string) => REGION_OF.has(code) && !!countryName(code);
