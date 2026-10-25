import { expect, test } from "bun:test";
import { CLASSIC_DETAIL_SCRIPT } from "../src/classic-detail";
import { patchText } from "../src/patch";

// the post engagements screen from the pinned client build, shortened: the
// Likes tab and its list are only for the post's author (C)
const SCREEN = `C=c?.user.id_str===g?.id_str||s===g?.screen_name,S=(0,R.A)({featureSwitches:k,isOwnPost:C}),M=[L("quotes"),L("retweets")];C&&M.push(L("likes"));let K=a.useMemo(()=>"likes"!==t||C?"quotes"===t?Q:$:(0,N.jsx)(h.A,{to:j}),[C,t])`;

test("classic post details show the Likes tab and list to everyone", () => {
	const patched = patchText(SCREEN);
	expect(patched).toContain('(C||window.__XITTER__?.classicDetail)&&M.push(L("likes"))');
	expect(patched).toContain('"likes"!==t||C||window.__XITTER__?.classicDetail?"quotes"===t');
	// what only the author gets stays theirs
	expect(patched).toContain("isOwnPost:C}");
	expect(() => new Function(patched)).not.toThrow();
});

test("the pinned build's Likes list shows to everyone who chose classic", () => {
	const real = `C&&L.push(q("likes"));let K=a.useMemo(()=>{if("likes"===t&&!C)return(0,$.jsx)(h.A,{to:j});return null},[C,t])`;
	const patched = patchText(real);
	expect(patched).toContain('(C||window.__XITTER__?.classicDetail)&&L.push(q("likes"))');
	expect(patched).toContain('if("likes"===t&&!C&&!window.__XITTER__?.classicDetail)return');
	expect(() => new Function(patched)).not.toThrow();
});

test("the counts row script parses", () => {
	expect(() => new Function(CLASSIC_DETAIL_SCRIPT)).not.toThrow();
});
