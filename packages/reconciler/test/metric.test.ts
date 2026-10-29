import { describe, expect, it } from "vitest";
import {
  computeMetric,
  METRIC_CLOSE_DAYS,
  METRIC_TARGET,
  METRIC_THRESHOLDS,
  METRIC_WINDOW_DAYS,
  type MetricEscrow,
  type MetricInput,
  type MetricResolution,
  type MetricTransfer,
} from "../src/metric.js";
import { distribute } from "../src/tw-math.js";
import { eur } from "../src/units.js";

const PLATFORM = "G_PLATFORM";
const TW = "G_TW_FEE";
const START = Date.parse("2027-01-10T00:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const WINDOW = { start: START, end: START + 45 * DAY };
const BPS = 1180;

/** Synthetic, clearly fake escrows: `n` escrows of `amount` across `buyers` buyers and `sellers` sellers. */
function escrows(n: number, amount: string, buyers: number, sellers: number, prefix = "E"): MetricEscrow[] {
  return Array.from({ length: n }, (_, i) => ({
    escrowId: `C_${prefix}${i}`,
    platform: PLATFORM,
    buyer: `G_BUYER_${i % buyers}`,
    seller: `G_SELLER_${i % sellers}`,
    amount: eur(amount),
    fundedAt: START + i * 1000,
  }));
}

function releases(es: MetricEscrow[], at = START + DAY) {
  return es.map((e, i) => ({ escrowId: e.escrowId, txHash: `rel-${e.escrowId}`, closedAt: at + i * 1000 }));
}

/** Resolution transfers exactly as the escrow contract makes them. */
function resolution(
  e: MetricEscrow,
  toSeller: bigint,
  buyerApproved: boolean,
  closedAt: number,
): { res: MetricResolution; transfers: MetricTransfer[] } {
  const txHash = `res-${e.escrowId}`;
  const d = distribute(
    [
      [e.buyer, e.amount - toSeller],
      [e.seller, toSeller],
    ],
    BPS,
  );
  const transfers: MetricTransfer[] = [
    { txHash, from: e.escrowId, to: TW, amount: d.trustlessWorkFee },
    { txHash, from: e.escrowId, to: PLATFORM, amount: d.platformFee },
    ...d.recipients.map((r) => ({ txHash, from: e.escrowId, to: r.address, amount: r.net })),
  ].filter((t) => t.amount > 0n);
  return { res: { escrowId: e.escrowId, txHash, closedAt, buyerApproved }, transfers };
}

function input(over: Partial<MetricInput>): MetricInput {
  return { platform: PLATFORM, window: WINDOW, escrows: [], releases: [], resolutions: [], transfers: [], ...over };
}

describe("Tranche 3 metric", () => {
  it("publishes the floor (EUR 4,000, 20 escrows, 12 buyers, 4 sellers) and the target", () => {
    expect(METRIC_THRESHOLDS).toEqual({ volume: eur("4000"), escrows: 20, buyers: 12, sellers: 4 });
    expect(METRIC_TARGET).toEqual({ volume: eur("7000"), escrows: 35, buyers: 20, sellers: 6 });
  });

  it("passes exactly at the floor, target not met", () => {
    const es = escrows(20, "200", 12, 4);
    const m = computeMetric(input({ escrows: es, releases: releases(es) }));
    expect(m.volume).toBe("4000.0000000");
    expect([m.escrows, m.distinctBuyers, m.distinctSellers]).toEqual([20, 12, 4]);
    expect(m.pass).toBe(true);
    expect(m.target.met).toBe(false);
  });

  it("reports the target exactly at the target values", () => {
    const es = escrows(35, "200", 20, 6);
    const m = computeMetric(input({ escrows: es, releases: releases(es) }));
    expect(m.volume).toBe("7000.0000000");
    expect(m.pass).toBe(true);
    expect(m.target).toEqual({ volume: true, escrows: true, buyers: true, sellers: true, met: true });
  });

  it("fails each floor value one below", () => {
    const vol = escrows(20, "199.9999999", 12, 4);
    expect(computeMetric(input({ escrows: vol, releases: releases(vol) })).thresholds).toEqual({
      volume: false,
      escrows: true,
      buyers: true,
      sellers: true,
    });
    const cnt = escrows(19, "300", 12, 4);
    expect(computeMetric(input({ escrows: cnt, releases: releases(cnt) })).thresholds.escrows).toBe(false);
    const buy = escrows(20, "300", 11, 4);
    expect(computeMetric(input({ escrows: buy, releases: releases(buy) })).thresholds.buyers).toBe(false);
    const sel = escrows(20, "300", 12, 3);
    expect(computeMetric(input({ escrows: sel, releases: releases(sel) })).thresholds.sellers).toBe(false);
  });

  it("gross on tw_release is the escrow amount, not the seller's net", () => {
    const es = escrows(1, "210", 1, 1);
    const m = computeMetric(input({ escrows: es, releases: releases(es) }));
    expect(m.volumeUnits).toBe(eur("210"));
  });

  it("a resolution to the seller counts via its EURC transfers, at gross", () => {
    const [e] = escrows(1, "210", 1, 1);
    if (!e) throw new Error("fixture");
    const r = resolution(e, e.amount, true, START + DAY);
    const m = computeMetric(input({ escrows: [e], resolutions: [r.res], transfers: r.transfers }));
    expect(m.escrows).toBe(1);
    expect(m.volumeUnits).toBe(eur("210"));
  });

  it("refunds do not count", () => {
    const [e] = escrows(1, "210", 1, 1);
    if (!e) throw new Error("fixture");
    const r = resolution(e, 0n, false, START + DAY);
    const m = computeMetric(input({ escrows: [e], resolutions: [r.res], transfers: r.transfers }));
    expect(m.escrows).toBe(0);
    expect(m.volumeUnits).toBe(0n);
    expect(m.refundsIgnored).toBe(1);
  });

  it("caps silent-buyer resolutions at half of the counted escrows", () => {
    const loud = escrows(10, "100", 10, 3, "L");
    const silent = escrows(15, "100", 15, 3, "S");
    const rs = silent.map((e, i) => resolution(e, e.amount, false, START + 2 * DAY + i * 1000));
    const m = computeMetric(
      input({
        escrows: [...loud, ...silent],
        releases: releases(loud),
        resolutions: rs.map((r) => r.res),
        transfers: rs.flatMap((r) => r.transfers),
      }),
    );
    expect(m.silentBuyer).toEqual({ total: 15, counted: 10 });
    expect(m.escrows).toBe(20);
    expect(m.volumeUnits).toBe(eur("2000"));
  });

  it("only counts the registered platform's escrows, inside the window, not excluded", () => {
    const es = escrows(4, "100", 4, 4);
    const [a, b, c, d] = es;
    if (!a || !b || !c || !d) throw new Error("fixture");
    b.platform = "G_OTHER_PLATFORM";
    c.excluded = true;
    const rel = releases(es);
    d.fundedAt = WINDOW.end; // the funding window's end is exclusive
    const m = computeMetric(input({ escrows: es, releases: rel }));
    expect(m.escrows).toBe(1);
    expect(m.excluded).toBe(1);
  });

  it("uses a 45-day funding window with 14 more days to close", () => {
    expect([METRIC_WINDOW_DAYS, METRIC_CLOSE_DAYS]).toEqual([45, 14]);
    const m = computeMetric(input({}));
    expect(m.window.closeBy).toBe(new Date(WINDOW.end + 14 * DAY).toISOString());
  });

  it("counts an escrow funded late in the window that closes after the window, before the deadline", () => {
    const [late, tooLate, preWindow] = escrows(3, "100", 3, 3);
    if (!late || !tooLate || !preWindow) throw new Error("fixture");
    late.fundedAt = WINDOW.end - DAY; // day 44
    tooLate.fundedAt = WINDOW.end - DAY;
    preWindow.fundedAt = START - DAY; // funded before the window, released inside it
    const rel = [
      { escrowId: late.escrowId, txHash: "rel-late", closedAt: WINDOW.end + 14 * DAY - 1 },
      { escrowId: tooLate.escrowId, txHash: "rel-too-late", closedAt: WINDOW.end + 14 * DAY },
      { escrowId: preWindow.escrowId, txHash: "rel-pre", closedAt: START + DAY },
    ];
    const m = computeMetric(input({ escrows: [late, tooLate, preWindow], releases: rel }));
    expect(m.escrows).toBe(1);
    expect(m.volumeUnits).toBe(eur("100"));
  });

  it("a resolution after the window counts when the escrow was funded inside it", () => {
    const [e] = escrows(1, "210", 1, 1);
    if (!e) throw new Error("fixture");
    const r = resolution(e, e.amount, true, WINDOW.end + 10 * DAY);
    const m = computeMetric(input({ escrows: [e], resolutions: [r.res], transfers: r.transfers }));
    expect(m.escrows).toBe(1);
  });

  it("reports the stretch goal without making it a condition", () => {
    const es = escrows(70, "215", 20, 6);
    const m = computeMetric(input({ escrows: es, releases: releases(es) }));
    expect(m.stretch).toEqual({ volume: true, escrows: true });
    expect(m.pass).toBe(true);
  });

  it("output is aggregate only", () => {
    const es = escrows(3, "100", 3, 3);
    const json = JSON.stringify(computeMetric(input({ escrows: es, releases: releases(es) })), (_k, v) =>
      typeof v === "bigint" ? v.toString() : v,
    );
    expect(json).not.toMatch(/C_E|G_BUYER|G_SELLER|rel-/);
  });
});
