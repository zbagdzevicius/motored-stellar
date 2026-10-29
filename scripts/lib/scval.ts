/**
 * Small ScVal builders shared by the CLIs. Ported from the lab scripts
 * (architect/testnet-v08/arch8.mjs), typed.
 *
 * `map` sorts keys the way Soroban requires for a #[contracttype] struct:
 * by symbol, ascending.
 */
import { Address, nativeToScVal, xdr } from '@stellar/stellar-sdk';

export const sym = (s: string): xdr.ScVal => xdr.ScVal.scvSymbol(s);
export const u32 = (n: number): xdr.ScVal => nativeToScVal(n, { type: 'u32' });
export const u64 = (n: bigint | number): xdr.ScVal => nativeToScVal(BigInt(n), { type: 'u64' });
export const i128 = (n: bigint | number): xdr.ScVal => nativeToScVal(BigInt(n), { type: 'i128' });
export const bytes = (b: Uint8Array): xdr.ScVal => xdr.ScVal.scvBytes(Buffer.from(b));
export const str = (s: string): xdr.ScVal => xdr.ScVal.scvString(s);
export const bool = (b: boolean): xdr.ScVal => xdr.ScVal.scvBool(b);
export const vec = (items: xdr.ScVal[]): xdr.ScVal => xdr.ScVal.scvVec(items);
export const addr = (a: string): xdr.ScVal => new Address(a).toScVal();
/** Option<Address>: Some(a) is the value itself, None is Void. */
export const optAddr = (a: string | undefined): xdr.ScVal => (a ? addr(a) : xdr.ScVal.scvVoid());

/** A #[contracttype] struct: a map keyed by symbols, sorted. */
export function map(o: Record<string, xdr.ScVal>): xdr.ScVal {
  return xdr.ScVal.scvMap(
    Object.keys(o)
      .sort()
      .map((k) => new xdr.ScMapEntry({ key: sym(k), val: o[k] as xdr.ScVal })),
  );
}

/**
 * Map<Address, i128> for Trustless Work distributions. Soroban maps must be
 * sorted by key, and Address keys sort by their XDR encoding.
 */
export function distributions(pairs: Array<[string, bigint]>): xdr.ScVal {
  return xdr.ScVal.scvMap(
    pairs
      .map(([a, v]) => new xdr.ScMapEntry({ key: addr(a), val: i128(v) }))
      .sort((x, y) => Buffer.compare(x.key.toXdr(), y.key.toXdr())),
  );
}

/** Unit enum variant with one payload, e.g. GuardSig::Release(BytesN<64>). */
export const variant = (name: string, payload: xdr.ScVal): xdr.ScVal => vec([sym(name), payload]);
