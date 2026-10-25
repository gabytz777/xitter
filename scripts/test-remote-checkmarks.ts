// Admin > Federation can hide the checkmarks other instances gave their
// accounts (model.ts remoteCheckHidden); local accounts keep theirs.
import { afterEach, expect, test } from "bun:test";
import type { User } from "../src/auth";
import { isVerified, shownVerifiedType, userResult } from "../src/model";
import { settings } from "../src/settings";

const account = (extra: Partial<User>) => ({ id: "1", screen_name: "jo", name: "Jo", verified_type: null, created_at: new Date("2024-01-01T00:00:00Z"), ...extra }) as User;
const hide = (hidden: boolean) => {
	(settings() as { remote_checkmarks: boolean }).remote_checkmarks = !hidden;
};

afterEach(() => hide(false));

test("remote checkmarks show by default", () => {
	const u = account({ verified_type: "business", instance: "xit.example.org" });
	expect(isVerified(u)).toBe(true);
	expect(shownVerifiedType(u)).toBe("business");
});

test("hidden, a remote account shows no checkmark", () => {
	hide(true);
	const u = account({ verified_type: "government", instance: "xit.example.org" });
	expect(isVerified(u)).toBe(false);
	expect(shownVerifiedType(u)).toBe(null);
	const r = userResult(u);
	expect(r.is_blue_verified).toBe(false);
	expect(JSON.stringify(r)).not.toContain('"verified_type":"Government"');
});

test("hidden, a remote affiliate shows no checkmark either", () => {
	hide(true);
	const org = { id: "9", screen_name: "acme@xit.example.org", name: "Acme", avatar_url: null };
	expect(isVerified(account({ org, instance: "xit.example.org" } as Partial<User>))).toBe(false);
});

test("hidden, local accounts keep theirs", () => {
	hide(true);
	const u = account({ verified_type: "blue", instance: null } as Partial<User>);
	expect(isVerified(u)).toBe(true);
	expect(shownVerifiedType(u)).toBe("blue");
});
