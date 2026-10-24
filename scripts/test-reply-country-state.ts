import { expect, test } from "bun:test";
import { patchCountryAudience } from "../src/reply-control-client";
import { patchText } from "../src/patch";

const AUDIENCE = 'function audience(e,t){return"co"===e&&null!=t&&t.length>0?{_type:"conversation_controls",conversationControlsValue:e,conversationControlRegionCodes:t}:{_type:"conversation_controls",conversationControlsValue:"co"===e?"all":e,conversationControlRegionCodes:void 0}}';
const MENU = 'function choose({defersChangesUntilApply:e=!1,dismiss:t,onChange:i,value:n}){let[c,h]=o.useState(null),[u]=o.useState(()=>"all"===n.policy?{restrictions:[],regionCodes:[]}:{restrictions:n.policies??[n.policy],regionCodes:n.selected??[]}),[p,g]=o.useState(u),{regionCodes:_,restrictions:y}=p,x=t=>{t&&(g(t),e||i(t))},A=e=>{let t;x((t=p.restrictions.includes("co"),e.length>0?{...p,restrictions:t?p.restrictions:[...p.restrictions,"co"],regionCodes:e}:t&&1!==p.restrictions.length?{...p,restrictions:p.restrictions.filter(e=>"co"!==e),regionCodes:[]}:null)),h(null)},v={isEveryone:0===y.length,onNavigate:h};return c?{onApply:A,onBack:A,options:c.options??[],requiresSelection:y.every(e=>"co"===e),value:y.includes("co")?_:[]}:{...v,apply:()=>{let n;e&&(n=p.restrictions.includes("co"),[...p.restrictions].sort().join()!==[...u.restrictions].sort().join()||n&&[...p.regionCodes].sort().join()!==[...u.regionCodes].sort().join())&&i(p),t()}}}let styles=o.A.create({});';

function menuHarness(initial: { policy: string; selected?: string[] }) {
	const state: any[] = [];
	const changes: any[] = [];
	const react = { A: { create: (value: any) => value }, useState: (initialValue: any) => {
		const index = cursor++;
		if (!(index in state)) state[index] = typeof initialValue === "function" ? initialValue() : initialValue;
		return [state[index], (value: any) => { state[index] = value; }];
	} };
	const choose = new Function("o", `${patchCountryAudience(MENU)}return choose`)(react);
	let cursor = 0;
	const render = () => {
		cursor = 0;
		return choose({ defersChangesUntilApply: true, dismiss: () => {}, onChange: (value: any) => changes.push(value), value: initial });
	};
	return { render, changes };
}

test("composer retains multiple standard and custom countries before serialization", () => {
	const audience = new Function(`${patchCountryAudience(AUDIENCE)}return audience`)();
	const selected = ["Mars", "Venus", "SE"];
	expect(audience("country", selected)).toEqual({ _type: "conversation_controls", conversationControlsValue: "country", conversationControlRegionCodes: selected });
	expect(audience("co", ["Europe"]).conversationControlRegionCodes).toEqual(["Europe"]);
	expect(audience("country", []).conversationControlsValue).toBe("all");
});

test("multi-select menu keeps Country separate from Regions and restores selected countries", () => {
	const harness = menuHarness({ policy: "all" });
	const selected = ["Mars", "Venus", "SE"];
	harness.render().onNavigate({ id: "country", options: [] });
	harness.render().onApply(selected);
	harness.render().onNavigate({ id: "country", options: [] });
	expect(harness.render().value).toEqual(selected);
	harness.render().onApply(selected);
	harness.render().apply();
	expect(harness.changes).toEqual([{ restrictions: ["country"], regionCodes: selected }]);
});

test("editing only the selected countries still saves when the audience is already Country", () => {
	const harness = menuHarness({ policy: "country", selected: ["Mars"] });
	harness.render().onNavigate({ id: "country", options: [] });
	expect(harness.render().value).toEqual(["Mars"]);
	harness.render().onApply(["Mars", "Venus"]);
	harness.render().apply();
	expect(harness.changes).toEqual([{ restrictions: ["country"], regionCodes: ["Mars", "Venus"] }]);
});

test("the existing Regions menu still saves its region audience", () => {
	const harness = menuHarness({ policy: "all" });
	harness.render().onNavigate({ id: "co", options: [] });
	harness.render().onApply(["Europe", "Asia"]);
	harness.render().apply();
	expect(harness.changes).toEqual([{ restrictions: ["co"], regionCodes: ["Europe", "Asia"] }]);
});

test("Country description uses the requested wording", () => {
	const source = 'Co:{id:"co",Icon:x.default,IconSelected:y.default,label:a,description:b,source:"remote",type:"navigate",order:60}';
	expect(patchText(source)).toContain('description:"Only accounts from selected countries can reply"');
});

test("already patched country audience helpers stay unchanged", () => {
	const patched = patchCountryAudience(MENU);
	expect(patchCountryAudience(patched)).toBe(patched);
});
