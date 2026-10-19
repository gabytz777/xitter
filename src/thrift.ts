// Thrift's binary protocol, as XChat uses it for message events and socket
// frames. A struct is read into its fields with their wire types kept, so what
// is read can be written back byte for byte, and built by hand:
//
//   { 1: str("123"), 7: struct({ 1: struct({ 100: bin(bytes) }) }) }

export const T = { bool: 2, byte: 3, double: 4, i16: 6, i32: 8, i64: 10, string: 11, struct: 12, map: 13, set: 14, list: 15 } as const;

export type Value =
	| { t: 2; v: boolean }
	| { t: 3 | 6 | 8; v: number }
	| { t: 4; v: number }
	| { t: 10; v: bigint }
	| { t: 11; v: Uint8Array }
	| { t: 12; v: Struct }
	| { t: 13; k: number; e: number; v: [Value, Value][] }
	| { t: 14 | 15; e: number; v: Value[] };
export type Struct = Record<number, Value>;

// builders
export const str = (s: string): Value => ({ t: 11, v: new TextEncoder().encode(s) });
export const bin = (b: Uint8Array): Value => ({ t: 11, v: b });
export const i64 = (n: bigint | number | string): Value => ({ t: 10, v: BigInt(n) });
export const i32 = (n: number): Value => ({ t: 8, v: n });
export const bool = (b: boolean): Value => ({ t: 2, v: b });
export const struct = (s: Struct): Value => ({ t: 12, v: s });
export const list = (e: number, v: Value[]): Value => ({ t: 15, e, v });

// readers of a field that may be missing
export const text = (v: Value | undefined) => (v?.t === 11 ? new TextDecoder().decode(v.v) : undefined);
export const bytes = (v: Value | undefined) => (v?.t === 11 ? v.v : undefined);
export const fields = (v: Value | undefined) => (v?.t === 12 ? v.v : undefined);
export const int = (v: Value | undefined) => (v?.t === 10 ? v.v : v?.t === 8 || v?.t === 6 || v?.t === 3 ? BigInt(v.v) : undefined);

// Everything here comes from clients. A negative length once moved the cursor
// backwards, so one 7-byte message looped forever and hung the server: lengths
// and counts must be non-negative and fit in what is left (every element takes
// at least a byte), and nesting stops at MAX_DEPTH. Each value becomes an
// object, so a blob of one-byte list elements grew ~50x in memory: a decode
// stops after MAX_VALUES, far more than any chat event holds.
const MAX_DEPTH = 64;
const MAX_VALUES = 50_000;

class Reader {
	pos = 0;
	depth = 0;
	values = 0;
	view: DataView;
	constructor(public buf: Uint8Array) {
		this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	}
	need(n: number) {
		if (!Number.isInteger(n) || n < 0 || this.pos + n > this.buf.length) throw new Error("thrift: truncated");
	}
	count(n: number) {
		if (n < 0 || n > this.buf.length - this.pos) throw new Error("thrift: bad count");
		return n;
	}
	value(t: number): Value {
		if (++this.depth > MAX_DEPTH) throw new Error("thrift: nested too deep");
		if (++this.values > MAX_VALUES) throw new Error("thrift: too many values");
		try {
			return this.read(t);
		} finally {
			this.depth--;
		}
	}
	read(t: number): Value {
		const v = this.view;
		switch (t) {
			case 2:
				this.need(1);
				return { t, v: this.buf[this.pos++] !== 0 };
			case 3:
				this.need(1);
				return { t, v: v.getInt8(this.pos++) };
			case 4:
				this.need(8);
				return { t, v: v.getFloat64((this.pos += 8) - 8) };
			case 6:
				this.need(2);
				return { t, v: v.getInt16((this.pos += 2) - 2) };
			case 8:
				this.need(4);
				return { t, v: v.getInt32((this.pos += 4) - 4) };
			case 10:
				this.need(8);
				return { t, v: v.getBigInt64((this.pos += 8) - 8) };
			case 11: {
				this.need(4);
				const n = v.getInt32((this.pos += 4) - 4);
				this.need(n);
				return { t, v: this.buf.slice(this.pos, (this.pos += n)) };
			}
			case 12:
				return { t, v: this.struct() };
			case 13: {
				this.need(6);
				const k = this.buf[this.pos], e = this.buf[this.pos + 1];
				const n = v.getInt32(this.pos + 2);
				this.pos += 6;
				this.count(n);
				const out: [Value, Value][] = [];
				for (let i = 0; i < n; i++) out.push([this.value(k), this.value(e)]);
				return { t, k, e, v: out };
			}
			case 14:
			case 15: {
				this.need(5);
				const e = this.buf[this.pos];
				const n = v.getInt32(this.pos + 1);
				this.pos += 5;
				this.count(n);
				const out: Value[] = [];
				for (let i = 0; i < n; i++) out.push(this.value(e));
				return { t, e, v: out };
			}
		}
		throw new Error(`thrift: unknown type ${t} at ${this.pos}`);
	}
	struct(): Struct {
		const out: Struct = {};
		for (;;) {
			this.need(1);
			const t = this.buf[this.pos++];
			if (t === 0) return out;
			this.need(2);
			const id = this.view.getInt16(this.pos);
			this.pos += 2;
			out[id] = this.value(t);
		}
	}
}

export function decode(buf: Uint8Array): Struct {
	const r = new Reader(buf);
	const s = r.struct();
	if (r.pos !== buf.length) throw new Error("thrift: trailing bytes");
	return s;
}

// written into one growing buffer: a number per byte took ~300 bytes of heap
// for each byte of a large event
class Writer {
	buf = new Uint8Array(256);
	pos = 0;
	room(n: number) {
		if (this.pos + n <= this.buf.length) return;
		const next = new Uint8Array(Math.max(this.buf.length * 2, this.pos + n));
		next.set(this.buf.subarray(0, this.pos));
		this.buf = next;
	}
	u8(n: number) {
		this.room(1);
		this.buf[this.pos++] = n & 255;
	}
	i16(n: number) {
		this.room(2);
		this.buf[this.pos++] = (n >> 8) & 255;
		this.buf[this.pos++] = n & 255;
	}
	i32(n: number) {
		this.room(4);
		this.buf[this.pos++] = (n >>> 24) & 255;
		this.buf[this.pos++] = (n >> 16) & 255;
		this.buf[this.pos++] = (n >> 8) & 255;
		this.buf[this.pos++] = n & 255;
	}
	bytes(b: Uint8Array) {
		this.room(b.length);
		this.buf.set(b, this.pos);
		this.pos += b.length;
	}
}

export function encode(s: Struct): Uint8Array {
	const w = new Writer();
	const value = (x: Value) => {
		switch (x.t) {
			case 2:
				return w.u8(x.v ? 1 : 0);
			case 3:
				return w.u8(x.v);
			case 4: {
				const b = new Uint8Array(8);
				new DataView(b.buffer).setFloat64(0, x.v);
				return w.bytes(b);
			}
			case 6:
				return w.i16(x.v);
			case 8:
				return w.i32(x.v);
			case 10: {
				const b = new Uint8Array(8);
				new DataView(b.buffer).setBigInt64(0, x.v);
				return w.bytes(b);
			}
			case 11:
				w.i32(x.v.length);
				return w.bytes(x.v);
			case 12:
				return fieldsOf(x.v);
			case 13:
				w.u8(x.k);
				w.u8(x.e);
				w.i32(x.v.length);
				for (const [k, v] of x.v) {
					value(k);
					value(v);
				}
				return;
			case 14:
			case 15:
				w.u8(x.e);
				w.i32(x.v.length);
				for (const v of x.v) value(v);
				return;
		}
	};
	const fieldsOf = (s: Struct) => {
		for (const [id, x] of Object.entries(s).sort(([a], [b]) => Number(a) - Number(b))) {
			w.u8(x.t);
			w.i16(Number(id));
			value(x);
		}
		w.u8(0);
	};
	fieldsOf(s);
	return w.buf.slice(0, w.pos);
}

export const fromBase64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));
export const toBase64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
