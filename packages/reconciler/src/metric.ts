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
 * - Window: an escrow counts when it is FUNDED inside the 45-day funding
 *   window and released or resolved to the seller within 14 days after that
 *   window ends (day 59 at the latest, inside the 90-day tranche window). An
 *   escrow funded near the end of the window still has time to close, so the
 *   whole 45 days of orders count.
 * - Floor (the committed condition), over the escrows so counted: at least
 *   EUR 4,000 released; at least 20 escrows released or resolved to the
 *   seller, from at least 12 distinct buyer wallets; at least 4 distinct
 *   sellers paid.
 * - Target (reported, not a condition): EUR 7,000, 35 escrows, 20 buyer
 *   wallets, 6 sellers. Stretch (reported): EUR 15,000, 70 escrows.
 * - Silent-buyer resolutions (resolved to the seller without the buyer's
 *   approval) count, are reported as a sub-count, and make up no more than
 *   two thirds of the counted escrows (at least one third are buyer
 *   approvals): any beyond that are not counted.
 *
 * Inputs are normalised events; reading them from an indexer or RPC is the
 * caller's job. Output is aggregate only.
 */
import { eur, formatEur, sum, type Units } from "./units.js";

const DAY_MS = 86_400_000;

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
  /** First funding of the escrow (epoch ms). Decides which window it belongs to. */
  fundedAt: number;
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

/** Committed floor: the public pass/fail condition for payment #3. */
export const METRIC_THRESHOLDS: Readonly<MetricThresholds> = Object.freeze({
  volume: eur("4000"),
  escrows: 20,
  buyers: 12,
  sellers: 4,
});

/** Length of the funding window. */
export const METRIC_WINDOW_DAYS = 45;
/** Days after the funding window ends in which a funded escrow may still close and count. */
export const METRIC_CLOSE_DAYS = 14;

/** Target: reported, not a condition. */
export const METRIC_TARGET: Readonly<MetricThresholds> = Object.freeze({
  volume: eur("7000"),
  escrows: 35,
  buyers: 20,
  sellers: 6,
});

/**
 * Silent-buyer cap: at most this many silent-buyer resolutions count per
 * counted buyer-approved escrow, so silent ones make up at most two thirds of
 * the counted escrows. Set from measured buyer-confirmation behaviour.
 */
export const SILENT_PER_APPROVED = 2;

/** Stretch goal: reported, not a condition. */
export const METRIC_STRETCH: Readonly<Pick<MetricThresholds, "volume" | "escrows">> = Object.freeze({
  volume: eur("15000"),
  escrows: 70,
});

export interface MetricInput {
  /** The registered platform address. */
  platform: string;
  /**
   * Funding window, inclusive start and exclusive end (epoch ms). `closeBy`
   * (exclusive) defaults to `end` plus METRIC_CLOSE_DAYS.
   */
  window: { start: number; end: number; closeBy?: number };
  escrows: MetricEscrow[];
  releases: MetricRelease[];
  resolutions: MetricResolution[];
  transfers: MetricTransfer[];
}

export interface MetricResult {
  /** Funding window and the closing deadline. */
  window: { start: string; end: string; closeBy: string };
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
  /** Whether each target value is met (reported, not a condition). */
  target: { volume: boolean; escrows: boolean; buyers: boolean; sellers: boolean; met: boolean };
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
  const closeBy = input.window.closeBy ?? end + METRIC_CLOSE_DAYS * DAY_MS;
  // Funded inside the funding window, closed after funding and before the deadline.
  const inWindow = (e: MetricEscrow, closedAt: number) =>
    e.fundedAt >= start && e.fundedAt < end && closedAt >= e.fundedAt && closedAt < closeBy;
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
    if (!escrow || !inWindow(escrow, r.closedAt)) continue;
    if (escrow.excluded) {
      excluded++;
      continue;
    }
    consider({ escrow, gross: escrow.amount, closedAt: r.closedAt, silent: false });
  }

  for (const r of input.resolutions) {
    const escrow = byId.get(r.escrowId);
    if (!escrow || !inWindow(escrow, r.closedAt)) continue;
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

  // Silent-buyer cap: counted silent <= 2 x counted buyer-approved, so silent
  // never exceeds two thirds of the counted escrows (at least one third are
  // buyer approvals). Earliest silent resolutions count first.
  const all = [...candidates.values()].sort((a, b) => a.closedAt - b.closedAt);
  const loud = all.filter((c) => !c.silent);
  const silent = all.filter((c) => c.silent);
  const silentCounted = silent.slice(0, SILENT_PER_APPROVED * loud.length);
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
    window: {
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
      closeBy: new Date(closeBy).toISOString(),
    },
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
    target: {
      volume: volumeUnits >= METRIC_TARGET.volume,
      escrows: counted.length >= METRIC_TARGET.escrows,
      buyers: buyers >= METRIC_TARGET.buyers,
      sellers: sellers >= METRIC_TARGET.sellers,
      met:
        volumeUnits >= METRIC_TARGET.volume &&
        counted.length >= METRIC_TARGET.escrows &&
        buyers >= METRIC_TARGET.buyers &&
        sellers >= METRIC_TARGET.sellers,
    },
    stretch: { volume: volumeUnits >= METRIC_STRETCH.volume, escrows: counted.length >= METRIC_STRETCH.escrows },
  };
}
