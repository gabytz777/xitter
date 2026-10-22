import { expect, test } from "bun:test";
import { csrfCookie, sessionCookies } from "../src/auth";
import { shell } from "../src/shell";

const available = await Bun.file(process.env.CLIENT_DIR ? `${process.env.CLIENT_DIR}/build.json` : "client/build.json").exists();
const shellTest = available ? test : test.skip;

test("CSRF cookie repair uses the same scope and flags as sign-in", () => {
	const cookie = csrfCookie("session-csrf");
	const cookies = sessionCookies({ token: "private-auth", csrf: "session-csrf", userId: "1" });
	expect(cookies).toContain(cookie);
	expect(cookie).toContain("ct0=session-csrf; Path=/;");
	expect(cookie).toContain("SameSite=Lax");
	expect(cookie).not.toContain("HttpOnly");
	expect(cookies[0]).toContain("HttpOnly");
});

shellTest("signed-in client receives its session CSRF token without exposing the authentication token", () => {
	const user = { id: "1", screen_name: "alice", name: "Alice", bio: "", location: "", avatar_url: null, banner_url: null, verified_type: null, created_at: new Date() };
	const page = shell(user, false, false, {}, [], null, undefined, undefined, "active-session-csrf")!;
	expect(page).toContain('"csrf":"active-session-csrf"');
	expect(page).not.toContain('"token":');
});

shellTest("signed-out pages do not expose a session CSRF token", () => {
	const page = shell(null, false, false, {}, [], null, undefined, undefined, "must-not-be-included")!;
	expect(page).not.toContain("must-not-be-included");
});
