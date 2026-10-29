import { describe, expect, it } from 'vitest';
import { StrKey, xdr } from '@stellar/stellar-sdk';
import { generateTestnetKeys } from '../lib/keystore.js';
import { DEFAULT_MAX_PLATFORM_FEE_BPS, DEFAULT_ORDER_AMOUNT, MAINNET_EURC_ISSUER, TESTNET_EURC, guardCfg, parseAssetArg, parseBps } from '../testnet/deploy.js';
import { AMT, buyerNeed, parseAmount } from '../testnet/order-kit.js';
import { toAmountString } from '../testnet/e2e.js';
import { feeCapProbe } from '../testnet/v010.js';
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
    expect(names).toEqual(['admin', 'breakglass_pk', 'contest_window', 'delay', 'max_platform_fee_bps', 'platform', 'registry', 'release_pk', 'resolver_admin', 'resolver_pk', 'rotate_delay', 'token', 'tw_fee', 'tw_wasm']);
    const cap = entries.find((e) => symName(e) === 'max_platform_fee_bps')!;
    expect(xdr.expectUnionVariant(cap.val, 'scvU32').u32).toBe(DEFAULT_MAX_PLATFORM_FEE_BPS);
    const tw = entries.find((e) => symName(e) === 'tw_wasm')!;
    expect(Buffer.from(xdr.expectUnionVariant(tw.val, 'scvBytes').bytes.value).toString('hex')).toBe(TW_WASM_HASH.testnet);
  });
});

describe('platform fee flags', () => {
  it('probes the fee cap one basis point over it and exactly at it', () => {
    expect(feeCapProbe(500)).toEqual({ over: 501, at: 500 });
    expect(feeCapProbe(0)).toEqual({ over: 1, at: 0 });
    expect(() => feeCapProbe(10_000)).toThrow();
    expect(() => feeCapProbe(4.5)).toThrow();
  });

  it('budgets the v010 run at one order held and spent', () => {
    expect(buyerNeed('v010', 20_000_000n)).toBe(22_000_000n);
  });

  it('parses basis points and refuses anything outside 0-10000', () => {
    expect(parseBps('max-platform-fee-bps', '500')).toBe(500);
    expect(parseBps('platform-fee-bps', '0')).toBe(0);
    for (const bad of ['-1', '10001', '4.7', 'abc', '']) expect(() => parseBps('max-platform-fee-bps', bad)).toThrow(/basis points/);
  });

  it('pins a custom cap into the guard Cfg', () => {
    const keys = generateTestnetKeys();
    const v = guardCfg({ keys, registry: StrKey.encodeContract(Buffer.alloc(32, 1)), token: StrKey.encodeContract(Buffer.alloc(32, 2)), delay: 120, rotateDelay: 604800, contestWindow: 120, maxPlatformFeeBps: 250 });
    const entries = xdr.expectUnionVariant(v, 'scvMap').map ?? [];
    const cap = entries.find((e) => xdr.expectUnionVariant(e.key, 'scvSymbol').sym.toString() === 'max_platform_fee_bps')!;
    expect(xdr.expectUnionVariant(cap.val, 'scvU32').u32).toBe(250);
  });
});

describe('external asset and order amount', () => {
  it('parses --asset CODE:ISSUER and refuses the mainnet EURC issuer', () => {
    expect(parseAssetArg(`EURC:${TESTNET_EURC.issuer}`)).toEqual({ code: 'EURC', issuer: TESTNET_EURC.issuer });
    expect(() => parseAssetArg(`EURC:${MAINNET_EURC_ISSUER}`)).toThrow(/MAINNET/);
    expect(() => parseAssetArg('EURC')).toThrow(/CODE:ISSUER/);
    expect(() => parseAssetArg(`EURC:${TESTNET_EURC.issuer.slice(0, -1)}A`)).toThrow();
    expect(() => parseAssetArg(`TOOLONGASSETCODE:${TESTNET_EURC.issuer}`)).toThrow();
  });

  it('parses decimal amounts into 7-decimal units', () => {
    expect(parseAmount('100')).toBe(AMT);
    expect(parseAmount(DEFAULT_ORDER_AMOUNT.external)).toBe(20_000_000n);
    expect(parseAmount('0.0000001')).toBe(1n);
    expect(parseAmount('1.5')).toBe(15_000_000n);
    for (const bad of ['0', '0.0', '-1', '1.00000001', 'abc', '']) expect(() => parseAmount(bad)).toThrow();
    expect(toAmountString(parseAmount('2.25'))).toBe('2.25');
  });

  it('fits every scenario into one 10 EURC faucet drip at the default external amount', () => {
    const amt = parseAmount(DEFAULT_ORDER_AMOUNT.external);
    expect(buyerNeed('e2e', amt)).toBe(44_000_000n);
    // e2e, e2e-claims and refusals in a row: each spends one order amount for good, so the
    // third starts after 2 spent and must still hold its peak (2 amounts + 10% margin).
    const worst = 2n * amt + buyerNeed('refusals', amt);
    expect(worst).toBeLessThanOrEqual(parseAmount('10'));
  });
});
