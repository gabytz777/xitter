// A software passkey for the passkey tests: makes credentials and signs
// sign-ins the way a platform authenticator would (attestation "none").
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { b64url } from "../src/webauthn";

// just the CBOR the authenticator writes: unsigned and negative ints, bytes, text, maps
function cbor(v: any): Buffer {
	const head = (major: number, n: number) =>
		n < 24 ? Buffer.from([(major << 5) | n]) : n < 256 ? Buffer.from([(major << 5) | 24, n]) : Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
	if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
	if (typeof v === "string") return Buffer.concat([head(3, Buffer.byteLength(v)), Buffer.from(v)]);
	if (v instanceof Uint8Array) return Buffer.concat([head(2, v.length), v]);
	if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
	throw new Error("unsupported");
}

export type Kind = { alg: number; make: () => { privateKey: KeyObject; publicKey: KeyObject }; cose: (jwk: JsonWebKey) => Map<number, any> };
const bytes = (s: string) => new Uint8Array(Buffer.from(s, "base64url"));
export const KINDS: Record<string, Kind> = {
	ES256: { alg: -7, make: () => generateKeyPairSync("ec", { namedCurve: "P-256" }), cose: (j) => new Map<number, any>([[1, 2], [3, -7], [-1, 1], [-2, bytes(j.x!)], [-3, bytes(j.y!)]]) },
	EdDSA: { alg: -8, make: () => generateKeyPairSync("ed25519"), cose: (j) => new Map<number, any>([[1, 1], [3, -8], [-1, 6], [-2, bytes(j.x!)]]) },
	RS256: { alg: -257, make: () => generateKeyPairSync("rsa", { modulusLength: 2048 }), cose: (j) => new Map<number, any>([[1, 3], [3, -257], [-1, bytes(j.n!)], [-2, bytes(j.e!)]]) },
};

export function authenticator(kind: Kind, expected: { challenge: string; origin: string; rpId: string }) {
	const { privateKey, publicKey } = kind.make();
	const id = new Uint8Array(crypto.getRandomValues(new Uint8Array(16)));
	const rpIdHash = createHash("sha256").update(expected.rpId).digest();
	const data = (flags: number, count: number, extra: Buffer = Buffer.alloc(0)) => {
		const c = Buffer.alloc(4);
		c.writeUInt32BE(count);
		return new Uint8Array(Buffer.concat([rpIdHash, Buffer.from([flags]), c, extra]));
	};
	const client = (type: string, over: Record<string, unknown> = {}) =>
		new TextEncoder().encode(JSON.stringify({ type, challenge: over.challenge ?? expected.challenge, origin: expected.origin, ...over }));
	return {
		id: b64url(id),
		create(flags = 0x45, over: Record<string, unknown> = {}) {
			const cred = Buffer.concat([Buffer.alloc(16), Buffer.from([0, id.length]), id, cbor(kind.cose(publicKey.export({ format: "jwk" })))]);
			return { id: b64url(id), clientDataJSON: client("webauthn.create", over), attestationObject: new Uint8Array(cbor(new Map<string, any>([["fmt", "none"], ["attStmt", new Map()], ["authData", data(flags, 0, cred)]]))) };
		},
		get(count: number, flags = 0x05, over: Record<string, unknown> = {}) {
			const authenticatorData = data(flags, count);
			const clientDataJSON = client("webauthn.get", over);
			const signed = Buffer.concat([authenticatorData, createHash("sha256").update(clientDataJSON).digest()]);
			const signature = new Uint8Array(sign(kind.alg === -8 ? null : "sha256", signed, privateKey));
			return { clientDataJSON, authenticatorData, signature };
		},
	};
}
