import { expect, test } from "bun:test";
import { isId, newId } from "../src/ids";

test("IDs fit PostgreSQL signed bigint before reaching queries", () => {
	for (const id of ["0", "0001", "9223372036854775807", newId()]) expect(isId(id)).toBe(true);
	for (const id of ["9223372036854775808", "9999999999999999999", "10000000000000000000", "-1", "1.5", "1e3", "", " 1", 1, null, undefined]) expect(isId(id)).toBe(false);
});
