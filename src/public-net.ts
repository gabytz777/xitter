// Addresses someone else chose (an OAuth app's metadata document, an instance
// to import an account from) lead only to the public internet: never to this
// instance's database, its realm or anything else beside it.
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

// loopback, private, link-local, carrier-grade NAT, documentation, benchmark,
// multicast and reserved ranges
const RESERVED = new BlockList();
for (const [address, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3]] as const)
	RESERVED.addSubnet(address, prefix, "ipv4");
// (BlockList matches every IPv4 address against ::ffff:0:0/96, so mapped
// addresses are unwrapped below rather than listed here)
// NAT64 (64:ff9b::/96), Teredo (2001::/32) and 6to4 (2002::/16) can carry any IPv4 address inside
for (const [address, prefix] of [["::", 127], ["64:ff9b::", 96], ["100::", 64], ["2001::", 32], ["2001:db8::", 32], ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]] as const)
	RESERVED.addSubnet(address, prefix, "ipv6");

export function reservedAddress(address: string): boolean {
	if (!isIP(address)) return true;
	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
	if (mapped) return RESERVED.check(mapped, "ipv4");
	// a mapped address written in hex (::ffff:7f00:1) is refused whatever it holds
	return /^::ffff:/i.test(address) || RESERVED.check(address, isIP(address) === 6 ? "ipv6" : "ipv4");
}

// tests swap the lookup out
export const resolver = { lookup: (host: string) => lookup(host, { all: true, verbatim: true }) };

export class NotPublic extends Error {}

// the name's addresses, refused unless every one of them is public
export async function publicAddresses(hostname: string): Promise<string[]> {
	const host = hostname.replace(/^\[|\]$/g, "");
	const addresses = isIP(host) ? [host] : (await resolver.lookup(host).catch(() => [])).map((a) => a.address);
	if (!addresses.length) throw new NotPublic(`${host} couldn't be found`);
	if (addresses.some(reservedAddress)) throw new NotPublic(`${host} is on a private network`);
	return addresses;
}

// fetch() to an address just checked, so a name can't pass the check and then
// answer the connection's own lookup with a private address. The certificate
// is still checked against the name, and redirects are left to the caller,
// who must check each hop again.
export async function publicFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
	const url = new URL(input);
	if (url.protocol !== "https:" && url.protocol !== "http:") throw new NotPublic(`${url.protocol} isn't fetched`);
	const host = url.hostname.replace(/^\[|\]$/g, "");
	const [address] = await publicAddresses(host);
	const target = new URL(url);
	target.hostname = isIP(address) === 6 ? `[${address}]` : address;
	const headers = new Headers(init.headers);
	headers.set("host", url.host);
	const tls = url.protocol === "https:" && !isIP(host) ? { tls: { serverName: host } } : {};
	return fetch(target, { ...init, headers, redirect: "manual", ...tls } as RequestInit);
}
