// Small byte helpers. Node >= 22.12 (node:crypto); no other dependencies.
import { createHash, createHmac, randomBytes } from "node:crypto";

/** Concatenates byte arrays. */
export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** SHA-256 of `data`. */
export function sha256(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(data).digest());
}

/** HMAC-SHA256(key, data). */
export function hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array {
  return new Uint8Array(createHmac("sha256", key).update(data).digest());
}

/** Cryptographically random bytes. */
export function random(n: number): Uint8Array {
  return new Uint8Array(randomBytes(n));
}

export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

export function toHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export function fromHex(s: string): Uint8Array {
  const h = s.startsWith("0x") ? s.slice(2) : s;
  if (!/^([0-9a-fA-F]{2})*$/.test(h)) throw new Error(`bad hex: ${s}`);
  return Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}

/** Big-endian u32 (Soroban u32 is unsigned 32-bit). */
export function u32be(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > 0xffff_ffff) throw new RangeError(`not a u32: ${n}`);
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n);
  return b;
}

export const U64_MAX = (1n << 64n) - 1n;

/** Normalises a u64 given as number or bigint, rejecting anything out of range. */
export function toU64(v: number | bigint): bigint {
  const n = typeof v === "bigint" ? v : Number.isSafeInteger(v) ? BigInt(v) : NaN;
  if (typeof n !== "bigint" || n < 0n || n > U64_MAX) throw new RangeError(`not a u64: ${String(v)}`);
  return n;
}

/** Big-endian u64, as Rust's `u64::to_be_bytes`. */
export function u64be(v: number | bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, toU64(v));
  return b;
}

/** Throws unless `b` is exactly `n` bytes. */
export function assertLen(b: Uint8Array, n: number, what: string): Uint8Array {
  if (!(b instanceof Uint8Array) || b.length !== n) throw new TypeError(`${what} must be ${n} bytes`);
  return b;
}
