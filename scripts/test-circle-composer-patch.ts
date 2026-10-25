import { expect, test } from "bun:test";
import { patchText } from "../src/patch";

// the composer's props and its audience menu from the pinned client build, shortened
const PROPS = `isSending:j,isAutoSaving:F,isSuperFollowsCreator:S.Fm,positionCursorAtBeginning:eg,viewerUser:L.Ay.selectViewerUser`;
const MENU = `tR=()=>null,tB=M().e815fc34,tL=M().c63602d4,tF=M().d52a1caa,tO=M().c6992b94;let tz=1,tV=e=>{let _=t.exclusivityControlValue||void 0};tN=M().baffe39a,tU=M().e815fc34,tH=M().d52a1caa,tK=M().c6992b94;`;

test("every account may pick the Circle while Circles are on", () => {
	expect(patchText(PROPS)).toContain("isSuperFollowsCreator:()=>!!window.__XITTER__?.circles,positionCursorAtBeginning:");
});

test("the audience menu's Subscribers choice reads Circle", () => {
	const patched = patchText(MENU);
	expect(patched).toContain('tF="Circle"');
	expect(patched).toContain('tH="Circle"');
	expect(patched).not.toContain("d52a1caa");
	// the other labels keep their strings
	expect(patched).toContain("tO=M().c6992b94");
});

test("Subscribers stays Subscribers outside the audience menu", () => {
	const elsewhere = "let a=M().d52a1caa;";
	expect(patchText(elsewhere)).toBe(elsewhere);
});
