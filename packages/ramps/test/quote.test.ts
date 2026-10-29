import { describe, expect, it } from "vitest";
import {
  EURC_UNITS_PER_EUR,
  type FeeSchedule,
  formatCents,
  formatUnits,
  onRampNetUnits,
  parseCents,
  parseUnits,
  quoteOffRamp,
  quoteOnRamp,
} from "../src/index.js";

const EUR = EURC_UNITS_PER_EUR;

describe("amount strings", () => {
  it("round-trips both scales without floating point", () => {
    expect(parseCents("2.01")).toBe(201n);
    expect(parseCents("120.0")).toBe(12000n);
    expect(formatCents(201n)).toBe("2.01");
    expect(parseUnits("1.5")).toBe(15_000_000n);
    expect(formatUnits(15_000_000n)).toBe("1.5000000");
  });

  it("refuses excess precision instead of rounding", () => {
    expect(() => parseCents("1.234")).toThrow(RangeError);
    expect(() => parseUnits("0.00000001")).toThrow(RangeError);
    expect(parseCents("1.2300")).toBe(123n);
  });
});

describe("on-ramp gross-up", () => {
  it("zero fees: SEPA amount equals the target, no surplus", () => {
    const q = quoteOnRamp(100n * EUR, { percentPpm: 0n, fixedCents: 0n });
    expect(q).toEqual({ sepaCents: 10_000n, feeCents: 0n, expectedNetUnits: 100n * EUR, surplusUnits: 0n });
  });

  it("percentage plus fixed fee: smallest gross that meets the target", () => {
    const s: FeeSchedule = { percentPpm: 2_500n, fixedCents: 30n }; // 0.25% + 0.30 EUR
    const target = 150n * EUR;
    const q = quoteOnRamp(target, s);
    expect(q.expectedNetUnits).toBeGreaterThanOrEqual(target);
    // One cent less must fall short: the quote is minimal.
    expect(onRampNetUnits(q.sepaCents - 1n, s)).toBeLessThan(target);
    // 150.00 + 0.30 = 150.30; / 0.9975 = 150.6767 -> 150.68; fee ceil(0.3767)=0.38 + 0.30 = 0.68.
    expect(q.sepaCents).toBe(15_068n);
    expect(q.feeCents).toBe(68n);
    expect(q.surplusUnits).toBe(0n);
  });

  it("is minimal and sufficient across many targets and schedules", () => {
    const schedules: FeeSchedule[] = [
      { percentPpm: 1n, fixedCents: 0n },
      { percentPpm: 10_000n, fixedCents: 0n },
      { percentPpm: 3_333n, fixedCents: 7n },
      { percentPpm: 0n, fixedCents: 99n, destinationFeeUnits: 12_345n },
    ];
    for (const s of schedules) {
      for (let cents = 1n; cents < 5_000n; cents += 37n) {
        const target = cents * 100_000n + (cents % 3n) * 777n; // includes sub-cent targets
        const q = quoteOnRamp(target, s);
        expect(q.expectedNetUnits).toBeGreaterThanOrEqual(target);
        expect(onRampNetUnits(q.sepaCents - 1n, s)).toBeLessThan(target);
        expect(q.surplusUnits).toBe(q.expectedNetUnits - target);
      }
    }
  });

  it("respects the route minimum", () => {
    const q = quoteOnRamp(1n * EUR, { percentPpm: 0n, fixedCents: 0n, minimumCents: 200n });
    expect(q.sepaCents).toBe(200n);
    expect(q.surplusUnits).toBe(1n * EUR);
  });

  it("validates inputs", () => {
    expect(() => quoteOnRamp(0n, { percentPpm: 0n, fixedCents: 0n })).toThrow(RangeError);
    expect(() => quoteOnRamp(1n, { percentPpm: 1_000_000n, fixedCents: 0n })).toThrow(RangeError);
    expect(() => quoteOnRamp(1n, { percentPpm: 0n, fixedCents: -1n })).toThrow(RangeError);
  });
});

describe("off-ramp quote", () => {
  it("drops sub-cent dust and deducts fees", () => {
    const q = quoteOffRamp(100n * EUR + 12_345n, { percentPpm: 5_000n, fixedCents: 25n });
    expect(q.grossCents).toBe(10_000n);
    expect(q.dustUnits).toBe(12_345n);
    expect(q.feeCents).toBe(75n); // 0.5% of 100.00 = 0.50, + 0.25
    expect(q.netCents).toBe(9_925n);
    expect(q.belowMinimum).toBe(false);
  });

  it("never goes negative and flags the minimum", () => {
    const q = quoteOffRamp(10n * 100_000n, { percentPpm: 0n, fixedCents: 50n, minimumCents: 200n });
    expect(q.netCents).toBe(0n);
    expect(q.belowMinimum).toBe(true);
  });
});
