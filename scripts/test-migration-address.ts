// The addresses an account migration may fetch from (migration-import.ts):
// public ones only, so the address someone types can't reach this instance's
// own network. bun test ./scripts/test-migration-address.ts
import { expect, test } from "bun:test";
import { MigrationError, parseSource, privateAddress } from "../src/migration-import";

test("private, loopback and link-local addresses are refused", () => {
	for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "::", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "224.0.0.1"])
		expect(privateAddress(ip)).toBe(true);
});

test("IPv4 carried inside IPv6, and the benchmark range, are refused too", () => {
	// new URL("https://[::ffff:127.0.0.1]").hostname is written in hex
	expect(new URL("https://[::ffff:127.0.0.1]/").hostname).toBe("[::ffff:7f00:1]");
	for (const ip of ["::ffff:7f00:1", "64:ff9b::7f00:1", "2002:7f00:1::", "2001::1", "198.18.0.1", "198.19.255.255", "not an address"]) expect(privateAddress(ip)).toBe(true);
});

test("publicFetch sends nothing to a name with any private address", async () => {
	const { publicFetch, resolver, NotPublic } = await import("../src/public-net");
	const real = resolver.lookup;
	const seen: string[] = [];
	const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => (seen.push(req.headers.get("host") ?? ""), new Response("reached")) });
	try {
		// a name that resolves privately is refused before anything is sent
		resolver.lookup = async () => [{ address: "127.0.0.1", family: 4 }];
		await expect(publicFetch(`http://rebind.example:${server.port}/`)).rejects.toBeInstanceOf(NotPublic);
		resolver.lookup = async () => [{ address: "8.8.8.8", family: 4 }, { address: "10.0.0.1", family: 4 }];
		await expect(publicFetch(`http://mixed.example:${server.port}/`)).rejects.toBeInstanceOf(NotPublic);
		expect(seen).toEqual([]);
	} finally {
		resolver.lookup = real;
		server.stop(true);
	}
});

test("public addresses are allowed", () => {
	for (const ip of ["1.1.1.1", "8.8.8.8", "172.32.0.1", "100.128.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) expect(privateAddress(ip)).toBe(false);
});

test("an address is an origin over HTTPS, without a path", () => {
	expect(parseSource("xit.example.org")).toEqual({ origin: "https://xit.example.org", host: "xit.example.org" });
	expect(parseSource(" https://Xit.Example.org/ ").host).toBe("xit.example.org");
	expect(parseSource("xit.example.org:8443").origin).toBe("https://xit.example.org:8443");
	for (const bad of ["", "https://xit.example.org/account", "https://u:p@xit.example.org", "ftp://xit.example.org", "https://xit.example.org/?a=1"])
		expect(() => parseSource(bad)).toThrow(MigrationError);
	if (!process.env.MIGRATION_ALLOW_HTTP && !process.env.FEDERATION_ALLOW_HTTP) expect(() => parseSource("http://xit.example.org")).toThrow(MigrationError);
});
