import { expect, test } from "bun:test";
import { TIDY_SCRIPT } from "../src/tidy";

// TIDY_SCRIPT is a template literal the server sends to the client, so escapes
// in the footer check have to survive one level of template processing. Read
// the regex back exactly as the browser receives it and match X's copyright.
function footerPattern(): RegExp {
	const marker = "return /";
	const footer = TIDY_SCRIPT.indexOf("function footer");
	expect(footer).toBeGreaterThan(-1);
	const start = TIDY_SCRIPT.indexOf(marker, footer);
	const end = TIDY_SCRIPT.indexOf("/.test(", start);
	expect(start).toBeGreaterThan(-1);
	expect(end).toBeGreaterThan(start);
	return new RegExp(TIDY_SCRIPT.slice(start + marker.length, end));
}

test("footer recognises X's copyright line", () => {
	const re = footerPattern();
	expect(re.test("© 2026 X Corp.")).toBe(true);
	expect(re.test("© 1999 Someone Corp.")).toBe(true);
	expect(re.test("© ddd Corp.")).toBe(false);
	expect(re.test("Copyright 2026 X Corp.")).toBe(false);
});
