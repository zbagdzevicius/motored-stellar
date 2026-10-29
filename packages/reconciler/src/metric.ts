/**
 * The Tranche 3 on-chain metric, as a pure function (used by `scripts/metric`).
 *
 * Definition (see docs/metric.md):
 * - Type: cumulative EURC volume released from the platform's registered
 *   escrows. A release counts when an escrow is released to the seller
 *   (`tw_release`), or when a dispute is resolved to the seller through the
 *   guard (`tw_disp_resolve` plus the EURC transfer to the seller, because the
 *   resolution event carries no amounts).
 * - Volume is the gross amount leaving the escrow (seller payout plus fees):
 *   `escrow.amount` on a release; the whole outflow of the resolution
 *   transaction when the seller is the only party paid. Refunds do not count.
 * - Thresholds, all within the window: at least EUR 7,000 released; at least
 *   35 escrows released or resolved to the seller, from at least 20 distinct
 *   buyer wallets; at least 6 distinct sellers paid.
 * - Silent-buyer resolutions (resolved to the seller without the buyer's
 *   approval) count, are reported as a sub-count, and make up no more than
 *   half of the counted escrows: any beyond that are not counted.
 *
 * Inputs are normalised events; reading them from an indexer or RPC is the
 * caller's job. Output is aggregate only.
 */
import { eur, formatEur, sum, type Units } from "./units.js";

/** An escrow from its `tw_init` event. */
export interface MetricEscrow {
  escrowId: string;
  /** Escrow `platform` role; only the registered platform's escrows count. */
  platform: string;
  /** Approver role (buyer wallet). */
  buyer: string;
  /** Receiver role (seller wallet). */
  seller: string;
  amount: Units;
  /** Test, team or related-party escrow, excluded from the metric. */
  excluded?: boolean;
}

/** A `tw_release` event. */
export interface MetricRelease {
  escrowId: string;
  txHash: string;
  closedAt: number;
}

/** A `tw_disp_resolve` event. */
export interface MetricResolution {
  escrowId: string;
  txHash: string;
  closedAt: number;
  /** Milestone approval as carried in the event's escrow payload. */
  buyerApproved: boolean;
}

/** An EURC transfer out of an escrow. */
export interface MetricTransfer {
  txHash: string;
  from: string;
  to: string;
  amount: Units;
}

export interface MetricThresholds {
  volume: Units;
  escrows: number;
  buyers: number;
  sellers: number;
}

/** Public metric thresholds. */
export const METRIC_THRESHOLDS: Readonly<MetricThresholds> = Object.freeze({
  volume: eur("7000"),
  escrows: 35,
  buyers: 20,
  sellers: 6,
});

/** Stretch goal: reported, not a condition. */
export const METRIC_STRETCH: Readonly<Pick<MetricThresholds, "volume" | "escrows">> = Object.freeze({
  volume: eur("15000"),
  escrows: 70,
});

export interface MetricInput {
  /** The registered platform address. */
  platform: string;
  /** Inclusive start, exclusive end (epoch ms). */
  window: { start: number; end: number };
  escrows: MetricEscrow[];
  releases: MetricRelease[];
  resolutions: MetricResolution[];
  transfers: MetricTransfer[];
}

export interface MetricResult {
  window: { start: string; end: string };
  volume: string;
  volumeUnits: Units;
  escrows: number;
  distinctBuyers: number;
  distinctSellers: number;
  silentBuyer: { total: number; counted: number };
  /** Releases or resolutions skipped because the escrow is excluded. */
  excluded: number;
  /** Resolutions in the window that paid the seller nothing (refunds). */
  refundsIgnored: number;
  thresholds: {
    volume: boolean;
    escrows: boolean;
    buyers: boolean;
    sellers: boolean;
  };
  pass: boolean;
  stretch: { volume: boolean; escrows: boolean };
}

interface Counted {
  escrow: MetricEscrow;
  gross: Units;
  closedAt: number;
  silent: boolean;
}

/** Compute the metric. Pure. */
export function computeMetric(input: MetricInput, thresholds: MetricThresholds = METRIC_THRESHOLDS): MetricResult {
  const { start, end } = input.window;
  const inWindow = (t: number) => t >= start && t < end;
  const byId = new Map(input.escrows.filter((e) => e.platform === input.platform).map((e) => [e.escrowId, e]));

  const candidates = new Map<string, Counted>();
  let excluded = 0;
  let refundsIgnored = 0;
  const consider = (c: Counted) => {
    const prev = candidates.get(c.escrow.escrowId);
    if (!prev || c.closedAt < prev.closedAt) candidates.set(c.escrow.escrowId, c);
  };

  for (const r of input.releases) {
    const escrow = byId.get(r.escrowId);
    if (!escrow || !inWindow(r.closedAt)) continue;
    if (escrow.excluded) {
      excluded++;
      continue;
    }
    consider({ escrow, gross: escrow.amount, closedAt: r.closedAt, silent: false });
  }

  for (const r of input.resolutions) {
    const escrow = byId.get(r.escrowId);
    if (!escrow || !inWindow(r.closedAt)) continue;
    const outflows = input.transfers.filter((t) => t.txHash === r.txHash && t.from === escrow.escrowId);
    const toSeller = sum(outflows.filter((t) => t.to === escrow.seller).map((t) => t.amount));
    if (toSeller === 0n) {
      refundsIgnored++;
      continue;
    }
    if (escrow.excluded) {
      excluded++;
      continue;
    }
    const toBuyer = sum(outflows.filter((t) => t.to === escrow.buyer).map((t) => t.amount));
    // All-to-seller: every outflow of the tx (seller net plus both fees) is
    // gross volume. A split resolution counts only the seller's net, which is
    // conservative (it never over-states volume).
    const gross = toBuyer === 0n ? sum(outflows.map((t) => t.amount)) : toSeller;
    consider({ escrow, gross, closedAt: r.closedAt, silent: !r.buyerApproved });
  }

  // Silent-buyer cap: counted silent <= counted non-silent, so silent never
  // exceeds half of the counted escrows. Earliest silent resolutions count first.
  const all = [...candidates.values()].sort((a, b) => a.closedAt - b.closedAt);
  const loud = all.filter((c) => !c.silent);
  const silent = all.filter((c) => c.silent);
  const silentCounted = silent.slice(0, loud.length);
  const counted = [...loud, ...silentCounted];

  const volumeUnits = sum(counted.map((c) => c.gross));
  const buyers = new Set(counted.map((c) => c.escrow.buyer)).size;
  const sellers = new Set(counted.map((c) => c.escrow.seller)).size;
  const t = {
    volume: volumeUnits >= thresholds.volume,
    escrows: counted.length >= thresholds.escrows,
    buyers: buyers >= thresholds.buyers,
    sellers: sellers >= thresholds.sellers,
  };
  return {
    window: { start: new Date(start).toISOString(), end: new Date(end).toISOString() },
    volume: formatEur(volumeUnits),
    volumeUnits,
    escrows: counted.length,
    distinctBuyers: buyers,
    distinctSellers: sellers,
    silentBuyer: { total: silent.length, counted: silentCounted.length },
    excluded,
    refundsIgnored,
    thresholds: t,
    pass: t.volume && t.escrows && t.buyers && t.sellers,
    stretch: { volume: volumeUnits >= METRIC_STRETCH.volume, escrows: counted.length >= METRIC_STRETCH.escrows },
  };
}
