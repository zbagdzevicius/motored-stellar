// Fee, cap, rounding and refund rules (D3b). The property test is a port of the
// lab's fee_prop.py / fee_fix.py with a seeded PRNG so failures reproduce.

import { describe, expect, it } from 'vitest';
import {
  applyBps,
  buyerFeeCents,
  cardNetCents,
  centsToUnits,
  escrowAmountCents,
  FeeRuleError,
  isEscrowEligible,
  MAINNET_MAX_PLATFORM_FEE_BPS,
  orderAmountsCents,
  platformFeeBps,
  quoteEscrow,
  refundTopUp,
  resolutionSplit,
  sellerResolution,
  twStandardFees,
} from '../src/index.js';

/** mulberry32: small deterministic PRNG. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const randint = (r: () => number, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;

function feeErrorCode(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof FeeRuleError) return e.code;
    throw e;
  }
  return undefined;
}

const SHIPPING_CENTS = [89, 129, 189, 249, 299, 399, 599, 899, 1299, 1899, 2399, 3199, 4799];

describe('card-rail rounding', () => {
  it('applyBps rounds half up', () => {
    expect(applyBps(10n, 500n)).toBe(1n); // 0.5 -> 1
    expect(applyBps(9n, 500n)).toBe(0n); // 0.45 -> 0
    expect(applyBps(9989n, 500n)).toBe(499n); // 499.45
    expect(applyBps(9990n, 500n)).toBe(500n); // 499.5
  });

  it('buyer fee is 5% capped at EUR 5, and 0 under a referral', () => {
    expect(buyerFeeCents(2000n, false)).toBe(100n);
    expect(buyerFeeCents(9989n, false)).toBe(499n);
    expect(buyerFeeCents(10000n, false)).toBe(500n);
    expect(buyerFeeCents(100000n, false)).toBe(500n);
    expect(buyerFeeCents(100000n, true)).toBe(0n);
  });

  it('card net subtracts the commission per item, rounded per item', () => {
    // 0.10 -> commission 0.01 (0.5 rounds up); 0.09 -> 0 (0.45 rounds down)
    expect(cardNetCents([10n, 9n])).toBe(9n + 9n);
    expect(cardNetCents([10000n])).toBe(9500n);
  });
});

describe('Trustless Work arithmetic', () => {
  it('floors the 0.3% fee: nothing below 334 units, 1 unit from 334', () => {
    expect(twStandardFees(333n, 0n).trustlessWorkFee).toBe(0n);
    expect(twStandardFees(334n, 0n).trustlessWorkFee).toBe(1n);
  });

  it('matches the lab release: 100 EURC at 470 bps nets the receiver 95 EURC', () => {
    const f = twStandardFees(1_000_000_000n, 470n);
    expect(f).toEqual({ trustlessWorkFee: 3_000_000n, platformFee: 47_000_000n, receiverAmount: 950_000_000n });
  });

  it('resolution fees are taken pro rata, floored per recipient, and conserve value', () => {
    const r = prng(7);
    for (let i = 0; i < 2_000; i++) {
      const a = BigInt(randint(r, 1, 50_000_000));
      const b = BigInt(randint(r, 1, 50_000_000));
      const bps = BigInt(randint(r, 0, 9_900));
      const s = resolutionSplit([['GA', a], ['GB', b]], bps);
      const std = twStandardFees(a + b, bps);
      const netTotal = s.net.reduce((x, y) => x + y.amount, 0n);
      expect(netTotal + s.trustlessWorkFee + s.platformFee).toBe(a + b);
      // Per-recipient flooring can only lower the fees actually charged, by < 1 unit per recipient per fee.
      expect(s.trustlessWorkFee <= std.trustlessWorkFee && std.trustlessWorkFee - s.trustlessWorkFee < 2n).toBe(true);
      expect(s.platformFee <= std.platformFee && std.platformFee - s.platformFee < 2n).toBe(true);
    }
  });

  it('two equal recipients of the lab overfunded escrow net 95 EURC each', () => {
    const s = resolutionSplit([['SELLER', 1_000_000_000n], ['BUYER', 1_000_000_000n]], 470n);
    expect(s.net).toEqual([
      { address: 'SELLER', amount: 950_000_000n },
      { address: 'BUYER', amount: 950_000_000n },
    ]);
  });

  it('rejects empty and non-positive distributions', () => {
    expect(() => resolutionSplit([], 100n)).toThrow(FeeRuleError);
    expect(() => resolutionSplit([['GA', 0n]], 100n)).toThrow(FeeRuleError);
  });
});

describe('platform fee rule', () => {
  it('property: the seller nets at least card net and at most 1 bp of the amount + 2 units more', () => {
    const r = prng(1);
    let checked = 0;
    let capped = 0;
    const cases: Array<{ items: bigint[]; ship: bigint; ref: boolean }> = [];
    for (let i = 0; i < 50_000; i++) {
      const k = pick(r, [1, 1, 1, 2, 3]);
      const items = Array.from({ length: k }, () =>
        BigInt(pick(r, [randint(r, 1, 100), randint(r, 100, 10_000), randint(r, 10_000, 500_000)])),
      );
      cases.push({ items, ship: BigInt(pick(r, SHIPPING_CENTS)), ref: r() < 0.1 });
    }
    // Boundaries around the EUR 5 buyer-fee cap and the EUR 1,000 order cap.
    for (const sub of [9989n, 9990n, 9999n, 10000n, 10001n, 10009n, 10010n, 99999n, 100000n]) {
      cases.push({ items: [sub], ship: 189n, ref: false });
    }
    const cap = { maxPlatformFeeBps: MAINNET_MAX_PLATFORM_FEE_BPS };
    for (const c of cases) {
      const o = orderAmountsCents({ itemGrossCents: c.items, shippingCents: c.ship, referral: c.ref });
      const amount = centsToUnits(o.escrowCents);
      const cardNet = centsToUnits(o.cardNetCents);
      // Shipping never enters the escrow: it is the separate payment to the platform.
      expect(o.shippingToPlatformCents).toBe(c.ship);
      expect(o.buyerPaysCents).toBe(o.escrowCents + c.ship);
      if (!isEscrowEligible({ amount, cardNet }, cap)) {
        capped++;
        const bps = platformFeeBps(amount, cardNet);
        expect(bps < 0n || bps > MAINNET_MAX_PLATFORM_FEE_BPS).toBe(true);
        // Only carts with an item of about EUR 1 or less, where per-item rounding outweighs the rates.
        expect(c.items.some((g) => g <= 110n)).toBe(true);
        continue;
      }
      const q = quoteEscrow({ amount, cardNet, shippingToPlatform: centsToUnits(c.ship) }, cap);
      expect(q.shippingToPlatform).toBe(centsToUnits(c.ship));
      const { trustlessWorkFee, platformFee, receiverAmount } = q.release;
      expect(trustlessWorkFee + platformFee + receiverAmount).toBe(amount);
      expect(receiverAmount >= cardNet).toBe(true);
      expect(receiverAmount - cardNet <= amount / 10_000n + 2n).toBe(true);
      expect(q.sellerOverCardNet).toBe(receiverAmount - cardNet);
      checked++;
    }
    expect(checked).toBeGreaterThan(30_000);
    expect(capped).toBeGreaterThan(0);
  });

  it("refuses a fee above Trustless Work's 9,900 bps cap", () => {
    // Shipping no longer enters the escrow, so no cart reaches this; the rule still holds.
    expect(platformFeeBps(10_000n, 3n)).toBe(9967n);
    expect(feeErrorCode(() => quoteEscrow({ amount: 10_000n, cardNet: 3n }))).toBe('PLATFORM_FEE_ABOVE_CAP');
  });

  it("refuses a fee above the guard's configured cap, and accepts one at it", () => {
    const amount = centsToUnits(10_500n);
    const cardNet = centsToUnits(9_500n);
    expect(quoteEscrow({ amount, cardNet }, { maxPlatformFeeBps: 922n }).platformFeeBps).toBe(922n);
    expect(feeErrorCode(() => quoteEscrow({ amount, cardNet }, { maxPlatformFeeBps: 921n }))).toBe('PLATFORM_FEE_ABOVE_CAP');
    // Run 9's testnet cap (500) is below a full-fee order's rate: such an order stayed on card there.
    expect(isEscrowEligible({ amount, cardNet }, { maxPlatformFeeBps: 500n })).toBe(false);
    expect(feeErrorCode(() => quoteEscrow({ amount, cardNet }, { maxPlatformFeeBps: 9_901n }))).toBe('INVALID_AMOUNT');
  });

  it('refuses a negative fee', () => {
    expect(feeErrorCode(() => quoteEscrow({ amount: 1_000n, cardNet: 1_000n }))).toBe('PLATFORM_FEE_NEGATIVE');
  });

  it('floors toward minus infinity, not toward zero', () => {
    // (9970*3 - 10000*3) / 3 = -30 exactly
    expect(platformFeeBps(3n, 3n)).toBe(-30n);
    // (9970*1001 - 10000*998) / 1001 = -30/1001: floor is -1, truncation would give 0
    expect(platformFeeBps(1001n, 998n)).toBe(-1n);
    // 9910 / 3 = 3303.33 -> 3303
    expect(platformFeeBps(3n, 2n)).toBe(3303n);
  });

  it('a typical order: EUR 100 item, EUR 4.99 shipping to the platform, EUR 5 buyer fee in the escrow', () => {
    const o = orderAmountsCents({ itemGrossCents: [10000n], shippingCents: 499n, referral: false });
    expect(o).toEqual({ escrowCents: 10500n, shippingToPlatformCents: 499n, cardNetCents: 9500n, buyerPaysCents: 10999n });
    expect(escrowAmountCents({ itemGrossCents: [10000n], referral: false })).toBe(10500n);
    const amount = centsToUnits(o.escrowCents);
    const q = quoteEscrow({ amount, cardNet: centsToUnits(9500n), shippingToPlatform: centsToUnits(499n) });
    expect(q.platformFeeBps).toBe(922n);
    expect(q.shippingToPlatform).toBe(centsToUnits(499n));
    expect(q.release.receiverAmount >= centsToUnits(9500n)).toBe(true);
    // The escrow pays out exactly its amount; shipping is not part of the release.
    expect(q.release.receiverAmount + q.release.platformFee + q.release.trustlessWorkFee).toBe(amount);
  });

  it('refuses negative shipping', () => {
    expect(() => orderAmountsCents({ itemGrossCents: [100n], shippingCents: -1n, referral: false })).toThrow(FeeRuleError);
    expect(feeErrorCode(() => quoteEscrow({ amount: 1_000_000n, cardNet: 900_000n, shippingToPlatform: -1n }))).toBe('INVALID_AMOUNT');
  });
});

describe('mainnet fee cap (1,000 bps, shipping outside the escrow)', () => {
  const cap = { maxPlatformFeeBps: MAINNET_MAX_PLATFORM_FEE_BPS };
  const bpsFor = (items: bigint[], referral = false) => {
    const o = orderAmountsCents({ itemGrossCents: items, shippingCents: 4799n, referral });
    return platformFeeBps(centsToUnits(o.escrowCents), centsToUnits(o.cardNetCents));
  };

  it('worst case at exact rates: 5% commission + 5% buyer fee quotes 922 bps (about 9.2%, Trustless Work 0.3% included)', () => {
    // amount = 1.05 x items, card net = 0.95 x items: floor((9970 x 1.05 - 9500) / 1.05) = 922.
    expect(bpsFor([10_000n])).toBe(922n);
    expect(bpsFor([100_000n])).toBeLessThan(922n); // above EUR 100 the EUR 5 buyer-fee cap lowers the rate
    expect(bpsFor([10_000n], true)).toBe(470n); // no buyer fee under a referral: commission less 0.3%
    expect(922n).toBeLessThan(MAINNET_MAX_PLATFORM_FEE_BPS);
  });

  it('every cart whose items are each above EUR 1.10 quotes at most 1,000 bps, whatever its shipping', () => {
    let worst = 0n;
    for (let g = 111n; g <= 500_000n; g += g < 20_000n ? 1n : 97n) {
      const bps = bpsFor([g]);
      if (bps > worst) worst = bps;
      expect(bps).toBeLessThanOrEqual(1_000n);
    }
    const r = prng(11);
    for (let i = 0; i < 20_000; i++) {
      const items = Array.from({ length: randint(r, 1, 10) }, () => BigInt(randint(r, 111, i % 2 ? 2_000 : 500_000)));
      const bps = bpsFor(items);
      if (bps > worst) worst = bps;
      expect(bps).toBeLessThanOrEqual(1_000n);
    }
    // Per-item rounding of EUR 1.11-2 items lifts the rate above 922, never past the cap.
    expect(worst).toBeGreaterThan(922n);
    expect(worst).toBeLessThanOrEqual(1_000n);
  });

  it('an item of EUR 1.10 is the largest that can exceed the cap; it stays on the card rail', () => {
    expect(bpsFor([110n])).toBe(1004n);
    const o = orderAmountsCents({ itemGrossCents: [110n], shippingCents: 499n, referral: false });
    expect(isEscrowEligible({ amount: centsToUnits(o.escrowCents), cardNet: centsToUnits(o.cardNetCents) }, cap)).toBe(false);
  });
});

describe('refund top-up', () => {
  it('top-up equals the Trustless Work fee plus the platform fee, so the buyer receives 100%', () => {
    const r = prng(3);
    for (let i = 0; i < 5_000; i++) {
      const balance = BigInt(randint(r, 1, 2_000_000_000));
      const bps = BigInt(randint(r, 0, 9_900));
      const t = refundTopUp(balance, bps);
      const std = twStandardFees(balance, bps);
      expect(t.topUp).toBe(std.trustlessWorkFee + std.platformFee);
      expect(t.buyerReceives).toBe(balance);
      expect(t.platformCost).toBe(std.trustlessWorkFee);
    }
  });

  it('lab numbers: 100 EURC at 470 bps refunds 95 from escrow plus a 5 EURC top-up', () => {
    expect(refundTopUp(1_000_000_000n, 470n)).toEqual({
      paidFromEscrow: 950_000_000n,
      topUp: 50_000_000n,
      buyerReceives: 1_000_000_000n,
      platformCost: 3_000_000n,
    });
  });
});

describe('seller resolution', () => {
  it('caps the seller at the escrow amount and returns excess to the buyer', () => {
    expect(sellerResolution(2_000n, 1_000n, 'S', 'B')).toEqual([['S', 1_000n], ['B', 1_000n]]);
    expect(sellerResolution(1_000n, 1_000n, 'S', 'B')).toEqual([['S', 1_000n]]);
  });
});
