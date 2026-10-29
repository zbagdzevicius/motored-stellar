// SPDX-License-Identifier: Apache-2.0
//
// Small ScVal builders shared by the escrow, guard and deployer calls.
// Ported from the lab scripts (arch8.mjs, e2e.mjs, tw.mjs).

import { Address, nativeToScVal, xdr } from '@stellar/stellar-sdk';

export const sym = (s: string): xdr.ScVal => xdr.ScVal.scvSymbol(s);
export const str = (s: string): xdr.ScVal => xdr.ScVal.scvString(s);
export const bool = (b: boolean): xdr.ScVal => xdr.ScVal.scvBool(b);
export const u32 = (n: number | bigint): xdr.ScVal => xdr.ScVal.scvU32(Number(n));
export const u64 = (n: number | bigint): xdr.ScVal => nativeToScVal(BigInt(n), { type: 'u64' });
export const i128 = (n: number | bigint): xdr.ScVal => nativeToScVal(BigInt(n), { type: 'i128' });
export const bytes = (b: Uint8Array): xdr.ScVal => xdr.ScVal.scvBytes(Buffer.from(b));
export const addr = (a: string): xdr.ScVal => new Address(a).toScVal();
export const vec = (items: xdr.ScVal[]): xdr.ScVal => xdr.ScVal.scvVec(items);

/**
 * A Soroban struct value: a map keyed by symbols. Soroban requires map keys in
 * ascending order; for symbols that is plain string order.
 */
export function struct(fields: Record<string, xdr.ScVal>): xdr.ScVal {
  return xdr.ScVal.scvMap(
    Object.keys(fields)
      .sort()
      .map((k) => new xdr.ScMapEntry({ key: sym(k), val: fields[k] as xdr.ScVal })),
  );
}

/**
 * `Map<Address, i128>` as used by `resolve_dispute` and `withdraw_remaining_funds`.
 * Keys are sorted by their XDR encoding, which matches Soroban's address order.
 */
export function addressAmountMap(entries: ReadonlyArray<readonly [string, bigint]>): xdr.ScVal {
  const seen = new Set<string>();
  for (const [a] of entries) {
    if (seen.has(a)) throw new Error(`duplicate distribution address ${a}`);
    seen.add(a);
  }
  return xdr.ScVal.scvMap(
    entries
      .map(([a, v]) => new xdr.ScMapEntry({ key: addr(a), val: i128(v) }))
      .sort((x, y) => Buffer.compare(x.key.toXdr(), y.key.toXdr())),
  );
}

/** Base64 XDR of a symbol, the form RPC `getEvents` topic filters take. */
export const symbolTopic = (s: string): string => sym(s).toXdr('base64');
/** Base64 XDR of an address ScVal, for topic filters. */
export const addressTopic = (a: string): string => addr(a).toXdr('base64');
