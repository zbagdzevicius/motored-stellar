import { describe, expect, it } from "vitest";
import { buyerTopUp, distribute, releaseDistribution, standardFees } from "../src/tw-math.js";

describe("Trustless Work v1 fee arithmetic", () => {
  it("release of EUR 210 at 1180 bps matches hand-computed legs", () => {
    // 2,100,000,000 units: 0.3% = 6,300,000; 11.8% = 247,800,000.
    expect(standardFees(2_100_000_000n, 1180)).toEqual({
      trustlessWorkFee: 6_300_000n,
      platformFee: 247_800_000n,
      receiverAmount: 1_845_900_000n,
    });
    const d = releaseDistribution("S", 2_100_000_000n, 1180);
    expect(d.trustlessWorkFee).toBe(6_300_000n);
    expect(d.platformFee).toBe(247_800_000n);
    expect(d.recipients[0]?.net).toBe(1_845_900_000n);
  });

  it("two-recipient resolution floors each recipient's fee share (recipient-favoured)", () => {
    const d = distribute(
      [
        ["B", 333_333_334n],
        ["S", 666_666_667n],
      ],
      500,
    );
    // Totals on 1,000,000,001: tw 3,000,000; platform 50,000,000.
    // Per recipient: B 1,000,000 + 16,666,666; S 1,999,999 + 33,333,333.
    expect(d.trustlessWorkFee).toBe(2_999_999n);
    expect(d.platformFee).toBe(49_999_999n);
    expect(d.recipients.map((r) => r.net)).toEqual([315_666_668n, 631_333_335n]);
    expect(buyerTopUp(d, "B")).toBe(17_666_666n);
  });

  it("conserves every unit across random distributions", () => {
    let seed = 7;
    const rnd = (n: number) => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed % n;
    };
    for (let i = 0; i < 2000; i++) {
      const b = BigInt(rnd(1_000_000_000));
      const s = BigInt(rnd(1_000_000_000)) + 1n;
      const bps = rnd(9901);
      const d = distribute(
        [
          ["B", b],
          ["S", s],
        ],
        bps,
      );
      const nets = d.recipients.reduce((a, r) => a + r.net, 0n);
      expect(nets + d.trustlessWorkFee + d.platformFee).toBe(b + s);
      const std = standardFees(b + s, bps);
      // Recipients never pay more than the contract's fee totals, and at most
      // one unit less per fee per recipient.
      expect(std.trustlessWorkFee - d.trustlessWorkFee).toBeGreaterThanOrEqual(0n);
      expect(std.trustlessWorkFee - d.trustlessWorkFee).toBeLessThanOrEqual(2n);
      expect(std.platformFee - d.platformFee).toBeLessThanOrEqual(2n);
    }
  });

  it("buyer-only refund top-up equals both fees", () => {
    const d = distribute([["B", 2_100_000_000n]], 1180);
    expect(buyerTopUp(d, "B")).toBe(254_100_000n);
    expect((d.recipients[0]?.net ?? 0n) + buyerTopUp(d, "B")).toBe(2_100_000_000n);
  });
});
