import { describe, expect, it } from 'vitest';
import { StrKey, xdr } from '@stellar/stellar-sdk';
import { generateTestnetKeys } from '../lib/keystore.js';
import { guardCfg } from '../testnet/deploy.js';
import { toAmountString } from '../testnet/e2e.js';
import { distributions } from '../lib/scval.js';
import { TW_WASM_HASH } from '../lib/tw.js';

describe('e2e helpers', () => {
  it('formats top-up amounts for classic payments', () => {
    expect(toAmountString(50_000_000n)).toBe('5');
    expect(toAmountString(53_000_000n)).toBe('5.3');
    expect(toAmountString(1n)).toBe('0.0000001');
    expect(() => toAmountString(-1n)).toThrow();
  });

  it('sorts distribution keys by XDR', () => {
    const keys = generateTestnetKeys();
    const m = xdr.expectUnionVariant(distributions([[keys.accounts.seller.publicKey, 1n], [keys.accounts.buyer.publicKey, 2n]]), 'scvMap').map ?? [];
    const enc = m.map((e) => e.key.toXdr());
    expect(Buffer.compare(enc[0]!, enc[1]!)).toBeLessThan(0);
  });
});

describe('guard Cfg', () => {
  it('is pinned to the Trustless Work testnet Wasm and sorted', () => {
    const keys = generateTestnetKeys();
    const v = guardCfg({ keys, registry: StrKey.encodeContract(Buffer.alloc(32, 1)), token: StrKey.encodeContract(Buffer.alloc(32, 2)), delay: 120, rotateDelay: 604800, contestWindow: 120 });
    const entries = xdr.expectUnionVariant(v, 'scvMap').map ?? [];
    const symName = (e: xdr.ScMapEntry) => xdr.expectUnionVariant(e.key, 'scvSymbol').sym.toString();
    const names = entries.map(symName);
    expect(names).toEqual([...names].sort());
    expect(names).toEqual(['admin', 'breakglass_pk', 'contest_window', 'delay', 'platform', 'registry', 'release_pk', 'resolver_admin', 'resolver_pk', 'rotate_delay', 'token', 'tw_fee', 'tw_wasm']);
    const tw = entries.find((e) => symName(e) === 'tw_wasm')!;
    expect(Buffer.from(xdr.expectUnionVariant(tw.val, 'scvBytes').bytes.value).toString('hex')).toBe(TW_WASM_HASH.testnet);
  });
});
