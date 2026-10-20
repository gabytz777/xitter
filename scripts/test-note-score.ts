import { test, expect } from "bun:test";
import { noteStatus } from "../src/note-score";

test("Community Notes needs a convincing active-voter majority", () => {
	expect(noteStatus(3, 3, 0)).toBe("NeedsMoreRatings");
	expect(noteStatus(5, 5, 0)).toBe("Helpful");
	expect(noteStatus(5, 4, 1)).toBe("NeedsMoreRatings");
	expect(noteStatus(10, 9, 1)).toBe("Helpful");
	expect(noteStatus(10, 1, 9)).toBe("NotHelpful");
	expect(noteStatus(10, 5, 5)).toBe("NeedsMoreRatings");
});
