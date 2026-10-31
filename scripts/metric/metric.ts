/**
 * Tranche 3 on-chain metric (pre-award; not billed, used by SCF deliverable D12) for a registered footprint.
 *
 * The metric definition itself lives in one place, `computeMetric` in
 * @motored-stellar/reconciler (see docs/metric.md): releases and resolutions to
 * the seller count, refunds do not, gross volume leaves the escrow; the floor
 * (PASS/FAIL) is EUR 4,000 / 20 escrows / 12 buyer wallets / 4 sellers, the
 * target EUR 7,000 / 35 / 20 / 6 is reported, not a condition; silent-buyer
 * resolutions at most two thirds of the counted escrows (counted silent <=
 * 2 x counted buyer-approved).
 *
 * This module adds what a public re-computation from chain data needs on top:
 * - footprint checks the reconciler does not make: each escrow must use the
 *   footprint token and name the guard as both release_signer and
 *   dispute_resolver, with receiver == service_provider and seller != buyer;
 * - the funding window: `windowDays` (default 45) consecutive days from the
 *   first funding of a counted (non-excluded, eligible) escrow, or
 *   `windowStart`; an escrow funded inside it counts if it closes within
 *   `closeDays` (default 14) after the window ends;
 * - mapping per-escrow observations (state + token transfers) into the
 *   reconciler's normalised events.
 */
import {
  computeMetric as reconcilerMetric,
  type MetricEscrow,
  type MetricInput,
  type MetricRelease,
  type MetricResolution,
  type MetricResult,
  type MetricTransfer,
} from '@motored-stellar/reconciler';

const DAY_MS = 86_400_000;
export const DEFAULT_WINDOW_DAYS = 45;
export const DEFAULT_CLOSE_DAYS = 14;

export interface Footprint {
  network: 'testnet' | 'mainnet';
  /** Platform fee account set on every escrow (G...). */
  platform: string;
  /** Guard contract (C...), release signer and dispute resolver on every escrow. */
  guard: string;
  /** Claim registry (C...). Reported, not needed for the count. */
  registry: string;
  /** Sponsor account (G...). Reported. */
  sponsor: string;
  /** Measured token contract (the EURC SAC on mainnet). */
  token: string;
  /** Escrow contract IDs, added as they are created. */
  escrows: string[];
  /** Test, founder, team and related-party escrows: listed separately, never counted. */
  excluded?: string[];
  /** Accounts whose reserves the sponsor sponsors. Reported as information. */
  sponsoredAccounts?: string[];
  /** Optional fixed window start (unix seconds); otherwise the first counted funding. */
  windowStart?: number;
  windowDays?: number;
  /** Days after the funding window in which a funded escrow may still close and count. */
  closeDays?: number;
  /** Optional first ledger to scan for events (RPC collection). */
  startLedger?: number;
  [extra: string]: unknown;
}

export interface Transfer {
  from: string;
  to: string;
  amount: bigint;
  /** Ledger close time, unix seconds. */
  at: number;
  txHash: string;
}

export interface EscrowObservation {
  id: string;
  amount: bigint;
  token: string;
  roles: {
    approver: string;
    receiver: string;
    service_provider: string;
    platform: string;
    release_signer: string;
    dispute_resolver: string;
  };
  flags: { released: boolean; resolved: boolean; disputed: boolean };
  /** Every milestone approved by the buyer (false = a silent-buyer resolution). */
  buyerApproved?: boolean;
  /** Token transfers into and out of the escrow. */
  transfers: Transfer[];
}

export interface FootprintMetricReport {
  network: Footprint['network'];
  windowDays: number;
  /** Escrows dropped by the footprint checks before the metric runs. */
  skipped: Array<{ escrow: string; reason: string }>;
  sponsoredAccounts: number;
  result: MetricResult | null;
  verdict: 'PASS' | 'FAIL';
}

/** Footprint and role checks; returns a skip reason or undefined. */
export function ineligible(fp: Footprint, o: EscrowObservation): string | undefined {
  if (o.token !== fp.token) return 'token is not the footprint token';
  if (o.roles.platform !== fp.platform) return 'platform role is not the footprint platform';
  if (o.roles.release_signer !== fp.guard || o.roles.dispute_resolver !== fp.guard) return 'guard is not release_signer and dispute_resolver';
  if (o.roles.receiver !== o.roles.service_provider) return 'receiver differs from service_provider';
  if (o.roles.receiver === o.roles.approver) return 'seller equals buyer';
  return undefined;
}

/** Outflows of one escrow grouped by transaction, earliest first. */
function outflowTxs(o: EscrowObservation): Array<{ txHash: string; at: number }> {
  const byTx = new Map<string, number>();
  for (const t of o.transfers) if (t.from === o.id) byTx.set(t.txHash, Math.max(byTx.get(t.txHash) ?? 0, t.at));
  return [...byTx.entries()].map(([txHash, at]) => ({ txHash, at })).sort((a, b) => a.at - b.at);
}

/** Maps eligible observations to the reconciler's normalised metric input. */
export function toMetricInput(fp: Footprint, observations: EscrowObservation[]): { input: MetricInput | null; skipped: FootprintMetricReport['skipped'] } {
  const byId = new Map(observations.map((o) => [o.id, o]));
  const excluded = new Set(fp.excluded ?? []);
  const skipped: FootprintMetricReport['skipped'] = [];
  const escrows: MetricEscrow[] = [];
  const releases: MetricRelease[] = [];
  const resolutions: MetricResolution[] = [];
  const transfers: MetricTransfer[] = [];
  const fundings: number[] = [];

  for (const id of new Set([...fp.escrows, ...excluded])) {
    const o = byId.get(id);
    if (!o) { skipped.push({ escrow: id, reason: 'no on-chain observation' }); continue; }
    const why = ineligible(fp, o);
    if (why) { skipped.push({ escrow: id, reason: why }); continue; }
    const inflows = o.transfers.filter((t) => t.to === o.id && t.amount > 0n);
    if (inflows.length === 0) { skipped.push({ escrow: id, reason: 'never funded' }); continue; }
    const isExcluded = excluded.has(id);
    const fundedAt = Math.min(...inflows.map((t) => t.at));
    if (!isExcluded) fundings.push(fundedAt);

    escrows.push({ escrowId: id, platform: o.roles.platform, buyer: o.roles.approver, seller: o.roles.receiver, amount: o.amount, fundedAt: fundedAt * 1000, excluded: isExcluded });
    for (const t of o.transfers) if (t.from === id) transfers.push({ txHash: t.txHash, from: t.from, to: t.to, amount: t.amount });
    const txs = outflowTxs(o);
    if (o.flags.released && !o.flags.resolved) {
      // A single-release escrow pays out once; the first outflow is the release.
      const tx = txs[0];
      if (tx) releases.push({ escrowId: id, txHash: tx.txHash, closedAt: tx.at * 1000 });
    } else if (o.flags.resolved) {
      for (const tx of txs) resolutions.push({ escrowId: id, txHash: tx.txHash, closedAt: tx.at * 1000, buyerApproved: o.buyerApproved ?? false });
    }
  }

  const startSec = fp.windowStart ?? (fundings.length ? Math.min(...fundings) : undefined);
  if (startSec === undefined) return { input: null, skipped };
  const start = startSec * 1000;
  const days = fp.windowDays ?? DEFAULT_WINDOW_DAYS;
  const end = start + days * DAY_MS;
  const closeBy = end + (fp.closeDays ?? DEFAULT_CLOSE_DAYS) * DAY_MS;
  return { input: { platform: fp.platform, window: { start, end, closeBy }, escrows, releases, resolutions, transfers }, skipped };
}

export function computeFootprintMetric(fp: Footprint, observations: EscrowObservation[]): FootprintMetricReport {
  const { input, skipped } = toMetricInput(fp, observations);
  const result = input ? reconcilerMetric(input) : null;
  return {
    network: fp.network,
    windowDays: fp.windowDays ?? DEFAULT_WINDOW_DAYS,
    skipped,
    sponsoredAccounts: fp.sponsoredAccounts?.length ?? 0,
    result,
    verdict: result?.pass ? 'PASS' : 'FAIL',
  };
}

/** JSON (de)serialisation: amounts travel as decimal strings of 7-decimal units. */
export interface ObservationFile {
  capturedAt?: string;
  source?: string;
  escrows: Array<Omit<EscrowObservation, 'amount' | 'transfers'> & { amount: string; transfers: Array<Omit<Transfer, 'amount'> & { amount: string }> }>;
}

export function observationsFromFile(f: ObservationFile): EscrowObservation[] {
  return f.escrows.map((e) => ({ ...e, amount: BigInt(e.amount), transfers: e.transfers.map((t) => ({ ...t, amount: BigInt(t.amount) })) }));
}

export function observationsToFile(obs: EscrowObservation[], source: string): ObservationFile {
  return {
    capturedAt: new Date().toISOString(),
    source,
    escrows: obs.map((e) => ({ ...e, amount: e.amount.toString(), transfers: e.transfers.map((t) => ({ ...t, amount: t.amount.toString() })) })),
  };
}

/** Human-readable summary: aggregates only (no per-order rows unless asked). */
export function renderReport(r: FootprintMetricReport, opts: { perEscrow?: boolean } = {}): string {
  const lines = [`network: ${r.network}`];
  const m = r.result;
  if (!m) {
    lines.push('no funded escrow in the footprint: nothing to measure');
  } else {
    const row = (pass: boolean, name: string, value: string | number) => `${pass ? 'PASS' : 'FAIL'}  ${name}: ${value}`;
    lines.push(
      `window: ${m.window.start} .. ${m.window.end} (${r.windowDays} days, funded); closed before ${m.window.closeBy}`,
      row(m.thresholds.volume, 'EURC released', `${m.volume} (floor >= 4000, target 7000)`),
      row(m.thresholds.escrows, 'escrows released or resolved to the seller', `${m.escrows} (floor >= 20, target 35)`),
      row(m.thresholds.buyers, 'distinct buyer wallets', `${m.distinctBuyers} (floor >= 12, target 20)`),
      row(m.thresholds.sellers, 'distinct sellers paid', `${m.distinctSellers} (floor >= 4, target 6)`),
      `info  silent-buyer resolutions: ${m.silentBuyer.counted} counted of ${m.silentBuyer.total}`,
      `info  excluded (test, team, related-party): ${m.excluded}; refunds ignored: ${m.refundsIgnored}`,
      `info  target (EUR 7,000 / 35 escrows / 20 buyers / 6 sellers): ${m.target.met ? 'met' : 'not met'}`,
      `info  stretch: volume ${m.stretch.volume ? 'met' : 'not met'}, escrows ${m.stretch.escrows ? 'met' : 'not met'}`,
    );
  }
  lines.push(`info  sponsored accounts: ${r.sponsoredAccounts}`, `info  dropped by footprint checks: ${r.skipped.length}`);
  if (opts.perEscrow) for (const s of r.skipped) lines.push(`  skip ${s.escrow}: ${s.reason}`);
  lines.push(`VERDICT: ${r.verdict}`);
  return lines.join('\n');
}

