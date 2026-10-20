// Pride flags people can pick at sign-up; one shows next to the name, in the
// place X puts an affiliate's organisation badge. The images are drawn here
// (served as /public/flag-<id>.svg), square so they read at badge size.

type Flag = { name: string; stripes: string[]; extra?: string };

export const FLAGS: Record<string, Flag> = {
	pride: { name: "Pride", stripes: ["#E40303", "#FF8C00", "#FFED00", "#008026", "#004CFF", "#732982"] },
	progress: {
		name: "Progress Pride",
		stripes: ["#E40303", "#FF8C00", "#FFED00", "#008026", "#004CFF", "#732982"],
		// chevrons on the hoist, outermost first: black, brown, light blue, pink, white
		extra: ["#000000", "#784F17", "#5BCEFA", "#F5A9B8", "#FFFFFF"]
			.map((c, i) => {
				const tip = 14 - i * 3;
				return `<path d="M0 0H${tip - 10}L${tip} 12L${tip - 10} 24H0Z" fill="${c}"/>`;
			})
			.join(""),
	},
	trans: { name: "Transgender", stripes: ["#5BCEFA", "#F5A9B8", "#FFFFFF", "#F5A9B8", "#5BCEFA"] },
	bi: { name: "Bisexual", stripes: ["#D60270", "#D60270", "#9B4F96", "#0038A8", "#0038A8"] },
	pan: { name: "Pansexual", stripes: ["#FF218C", "#FFD800", "#21B1FF"] },
	lesbian: { name: "Lesbian", stripes: ["#D52D00", "#EF7627", "#FF9A56", "#FFFFFF", "#D162A4", "#B55690", "#A30262"] },
	gay: { name: "Gay", stripes: ["#078D70", "#26CEAA", "#98E8C1", "#FFFFFF", "#7BADE2", "#5049CC", "#3D1A78"] },
	nonbinary: { name: "Non-binary", stripes: ["#FCF434", "#FFFFFF", "#9C59D1", "#2C2C2C"] },
	genderfluid: { name: "Genderfluid", stripes: ["#FF76A4", "#FFFFFF", "#C011D7", "#000000", "#2F3CBE"] },
	agender: { name: "Agender", stripes: ["#000000", "#BCC4C7", "#FFFFFF", "#B7F684", "#FFFFFF", "#BCC4C7", "#000000"] },
	asexual: { name: "Asexual", stripes: ["#000000", "#A3A3A3", "#FFFFFF", "#800080"] },
	aromantic: { name: "Aromantic", stripes: ["#3DA542", "#A7D379", "#FFFFFF", "#A9A9A9", "#000000"] },
	intersex: { name: "Intersex", stripes: ["#FFD800"], extra: `<circle cx="12" cy="12" r="5.5" fill="none" stroke="#7902AA" stroke-width="2"/>` },
};

export const isFlag = (id: unknown): id is string => typeof id === "string" && Object.hasOwn(FLAGS, id);

export const MAX_FLAGS = 4;
export const flagList = (v: unknown): string[] => (typeof v === "string" ? [...new Set(v.split(",").map((f) => f.trim()))].filter(isFlag).slice(0, MAX_FLAGS) : []);
export const flagValue = (v: unknown): string | null => flagList(v).join(",") || null;
export const unknownFlag = (v: unknown) => typeof v === "string" && v.split(",").some((f) => f.trim() && !isFlag(f.trim()));

export function flagSvg(id: string): string | undefined {
	const f = FLAGS[id];
	if (!f) return undefined;
	const h = 24 / f.stripes.length;
	const rects = f.stripes.map((c, i) => `<rect y="${(i * h).toFixed(3)}" width="24" height="${(h + 0.05).toFixed(3)}" fill="${c}"/>`).join("");
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${rects}${f.extra ?? ""}</svg>`;
}
