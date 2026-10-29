/**
 * The 15-minute reconciliation.
 *
 * For every escrow the ledger lists, compare the on-chain EURC balance, the
 * Trustless Work flags, every EURC transfer in and out, and each refund top-up
 * against what the ledger expects, to the base unit. Differences are
 * classified (see `findings.ts`); whatever no classification explains is
 * counted as unexplained cents.
 *
 * `reconcileEscrow` is pure. `runOnce` does the I/O through the ports and is
 * the only entry point a scheduler needs: the host runs it every 15 minutes
 * and persists `nextCursorLedger` between runs. There is no database and no
 * job queue in this package.
 */
import type { ReconcilerConfig } from "./config.js";
import { FINDING_KINDS, finding, type Finding, type FindingKind } from "./findings.js";
import type {
  Alert,
  ChainReader,
  Clock,
  EscrowChainState,
  EurcBalance,
  EurcTransfer,
  ExpectedEscrow,
  ExpectedExit,
  LedgerSource,
  ReportSink,
  TxStatus,
} from "./ports.js";
import { buyerTopUp, distribute, releaseDistribution, type Distribution } from "./tw-math.js";
import { absUnits, formatEur, sum, unitsToCentsCeil, type Units } from "./units.js";

/** Everything the reconciler observed on chain for one escrow. */
export interface EscrowObservation {
  state: EscrowChainState;
  balance: EurcBalance;
  /** EURC transfers into or out of the escrow. */
  transfers: EurcTransfer[];
  /** Final status of every exit transaction the ledger lists. */
  txStatus: ReadonlyMap<string, TxStatus>;
  /** EURC transfers out of the platform fee account (for refund top-ups). */
  platformTransfers: EurcTransfer[];
}

/** Context that is the same for every escrow in a run. */
export interface EscrowContext {
  config: ReconcilerConfig;
  now: number;
  /** Fee accounts found without an authorised trustline this run. */
  feeAccountProblems: string[];
}

/** Result of reconciling one escrow. */
export interface EscrowResult {
  findings: Finding[];
  /** Refunds whose buyer leg plus top-up equals 100% of the buyer's gross. */
  refundsComplete: number;
}

const FINAL_WITHOUT_PAYMENT = new Set(["cancelled", "expired"]);

/** Reconcile one escrow. Pure: no I/O, deterministic for a given `now`. */
export function reconcileEscrow(e: ExpectedEscrow, obs: EscrowObservation, ctx: EscrowContext): EscrowResult {
  const { config, now } = ctx;
  const id = e.escrowId;
  const ref = { escrowId: id, orderRef: e.orderRef };
  const out: Finding[] = [];
  let refundsComplete = 0;

  const inflows = obs.transfers.filter((t) => t.to === id && t.from !== id);
  const outflows = obs.transfers.filter((t) => t.from === id && t.to !== id);
  const totalIn = sum(inflows.map((t) => t.amount));
  const totalOut = sum(outflows.map((t) => t.amount));
  const balance = obs.balance.amount;
  const flags = obs.state.flags;
  const settled = flags.released || flags.resolved;

  // 1. Conservation. If net transfers do not explain the balance, some events
  //    are missing (RPC retention, an indexer gap). Never pass silently.
  const drift = totalIn - totalOut - balance;
  if (drift !== 0n) {
    out.push(
      finding("rpc_event_gap", `balance ${formatEur(balance)} differs from net transfers by ${formatEur(drift)}`, {
        ...ref,
        unexplainedUnits: absUnits(drift),
      }),
    );
  }

  // 2. The escrow on chain must be the escrow the ledger describes.
  const mismatches: string[] = [];
  if (obs.state.amount !== e.amount) mismatches.push("amount");
  if (obs.state.platformFeeBps !== e.platformFeeBps) mismatches.push("platform fee");
  if (obs.state.approver !== e.buyer) mismatches.push("approver");
  if (obs.state.receiver !== e.seller) mismatches.push("receiver");
  if (obs.state.platform !== config.platformAccount) mismatches.push("platform");
  if (mismatches.length > 0) {
    out.push(finding("escrow_mismatch", `on-chain escrow differs from ledger: ${mismatches.join(", ")}`, ref));
  }

  // 3. Per-order cap (a checkout control; nothing on chain enforces it).
  if (e.amount > config.perOrderCap) {
    out.push(finding("per_order_cap_exceeded", `amount ${formatEur(e.amount)} above per-order cap`, ref));
  }

  // 4. Frozen balance.
  if (!obs.balance.authorized && balance > 0n) {
    out.push(finding("frozen_balance", `${formatEur(balance)} frozen by the issuer`, { ...ref, explainedUnits: balance }));
  }

  // 5. Funding.
  if (e.paymentDeadline !== undefined && FINAL_WITHOUT_PAYMENT.has(e.status)) {
    const deadline = e.paymentDeadline;
    const late = sum(inflows.filter((t) => t.closedAt > deadline).map((t) => t.amount));
    if (late > 0n) {
      out.push(
        finding("sepa_after_expiry", `${formatEur(late)} funded into the escrow after the payment deadline`, {
          ...ref,
          explainedUnits: late,
        }),
      );
    }
    const lateRamp = sum((e.rampDeposits ?? []).filter((d) => d.arrivedAt > deadline).map((d) => d.amount));
    if (lateRamp > 0n) {
      // The EURC sits in the buyer's own wallet, not in the escrow: accounted
      // for, nothing to move, the buyer keeps or off-ramps it.
      out.push(
        finding("sepa_after_expiry", `${formatEur(lateRamp)} reached the buyer's wallet after the payment deadline`, {
          ...ref,
          explainedUnits: lateRamp,
        }),
      );
    }
  }
  if (!settled) {
    const buyerIn = sum(inflows.filter((t) => t.from === e.buyer).map((t) => t.amount));
    const thirdIn = totalIn - buyerIn;
    if (buyerIn > 0n && buyerIn < e.amount) {
      out.push(
        finding("partial_funding", `buyer funded ${formatEur(buyerIn)} of ${formatEur(e.amount)}`, {
          ...ref,
          explainedUnits: buyerIn,
        }),
      );
    }
    if (buyerIn > e.amount) {
      out.push(
        finding("excess_funding", `buyer overpaid by ${formatEur(buyerIn - e.amount)}`, {
          ...ref,
          explainedUnits: buyerIn - e.amount,
        }),
      );
    }
    if (thirdIn > 0n) {
      out.push(
        finding("excess_funding", `${formatEur(thirdIn)} sent to the escrow by a third party (dust)`, {
          ...ref,
          explainedUnits: thirdIn,
        }),
      );
    }
  } else if (balance > 0n) {
    out.push(
      finding("excess_funding", `${formatEur(balance)} left after the escrow settled; withdraw to the buyer`, {
        ...ref,
        explainedUnits: balance,
      }),
    );
  }

  // 6. Ledger status against flags.
  if (e.status === "released" && !flags.released) {
    out.push(finding("ledger_chain_mismatch", "ledger says released, escrow flag is not set", ref));
  }
  if (e.status === "resolved" && !flags.resolved) {
    out.push(finding("ledger_chain_mismatch", "ledger says resolved, escrow flag is not set", ref));
  }

  // 7. Exits: predict every leg with the Trustless Work fee arithmetic and
  //    match the transfers of that transaction to the unit.
  const matchedTx = new Set<string>();
  for (const exit of e.exits) {
    const status = obs.txStatus.get(exit.txHash) ?? "not_found";
    const gross = exit.kind === "release" ? e.amount : exit.toBuyer + exit.toSeller;
    if (status === "failed" || (status === "not_found" && now - exit.submittedAt > config.pendingGraceMs)) {
      const cause =
        ctx.feeAccountProblems.length > 0 ? `; likely cause: fee account without trustline` : "";
      const what = status === "failed" ? "failed" : "is not on chain after the grace period";
      out.push(
        finding("release_reverted", `${exit.kind} ${short(exit.txHash)} ${what}${cause}`, {
          ...ref,
          explainedUnits: gross,
        }),
      );
      continue;
    }
    if (status === "not_found") {
      out.push(
        finding("exit_pending", `${exit.kind} ${short(exit.txHash)} submitted, not on chain yet`, {
          ...ref,
          explainedUnits: gross,
        }),
      );
      continue;
    }

    matchedTx.add(exit.txHash);
    const dist = exitDistribution(e, exit);
    const legs = outflows.filter((t) => t.txHash === exit.txHash);
    out.push(...matchLegs(dist, legs, config, ref, exit));

    if (exit.toBuyer > 0n) {
      const r = checkTopUp(e, exit, dist, legs, obs, ctx);
      out.push(...r.findings);
      refundsComplete += r.complete ? 1 : 0;
    }
  }

  // 8. Any outgoing transfer outside a confirmed, expected exit.
  for (const t of outflows) {
    if (matchedTx.has(t.txHash)) continue;
    out.push(
      finding("unexplained_transfer", `${formatEur(t.amount)} left the escrow in unexpected tx ${short(t.txHash)}`, {
        ...ref,
        unexplainedUnits: t.amount,
      }),
    );
  }

  return { findings: out, refundsComplete };
}

/** Predicted distribution for one exit. */
export function exitDistribution(e: ExpectedEscrow, exit: ExpectedExit): Distribution {
  if (exit.kind === "release") return releaseDistribution(e.seller, e.amount, e.platformFeeBps);
  return distribute(
    [
      [e.buyer, exit.toBuyer],
      [e.seller, exit.toSeller],
    ],
    e.platformFeeBps,
  );
}

/** Compare predicted legs with the transfers of the exit's transaction. */
function matchLegs(
  dist: Distribution,
  legs: EurcTransfer[],
  config: ReconcilerConfig,
  ref: { escrowId: string; orderRef: string },
  exit: ExpectedExit,
): Finding[] {
  const expected = new Map<string, Units>();
  const add = (m: Map<string, Units>, k: string, v: Units) => {
    if (v !== 0n) m.set(k, (m.get(k) ?? 0n) + v);
  };
  add(expected, config.trustlessWorkFeeAccount, dist.trustlessWorkFee);
  add(expected, config.platformAccount, dist.platformFee);
  for (const r of dist.recipients) add(expected, r.address, r.net);

  const actual = new Map<string, Units>();
  for (const t of legs) add(actual, t.to, t.amount);

  const out: Finding[] = [];
  for (const addr of new Set([...expected.keys(), ...actual.keys()])) {
    const want = expected.get(addr) ?? 0n;
    const got = actual.get(addr) ?? 0n;
    if (want === got) continue;
    const kind: FindingKind = want > got ? "missing_transfer" : "unexplained_transfer";
    out.push(
      finding(kind, `${exit.kind} ${short(exit.txHash)}: leg ${short(addr)} expected ${formatEur(want)}, got ${formatEur(got)}`, {
        ...ref,
        unexplainedUnits: absUnits(want - got),
      }),
    );
  }
  return out;
}

/**
 * A buyer-paying exit leaves the buyer short by the two fee shares the
 * contract deducted from their leg. The platform sends exactly that as a
 * top-up from its fee account, so the refund reaches 100%.
 */
function checkTopUp(
  e: ExpectedEscrow,
  exit: ExpectedExit,
  dist: Distribution,
  legs: EurcTransfer[],
  obs: EscrowObservation,
  ctx: EscrowContext,
): { findings: Finding[]; complete: boolean } {
  const ref = { escrowId: e.escrowId, orderRef: e.orderRef };
  const owed = buyerTopUp(dist, e.buyer);
  const buyerNet = sum(legs.filter((t) => t.to === e.buyer).map((t) => t.amount));
  if (owed === 0n) return { findings: [], complete: buyerNet === exit.toBuyer };

  const exitTime = legs.reduce((m, t) => Math.max(m, t.closedAt), exit.submittedAt);
  const record = e.topUps.find((t) => t.exitTxHash === exit.txHash);
  const paid = record?.txHash
    ? sum(
        obs.platformTransfers
          .filter((t) => t.txHash === record.txHash && t.from === ctx.config.platformAccount && t.to === e.buyer)
          .map((t) => t.amount),
      )
    : 0n;

  if (paid === 0n) {
    const within = ctx.now - exitTime <= ctx.config.topUpGraceMs;
    return {
      findings: [
        within
          ? finding("topup_pending", `refund top-up of ${formatEur(owed)} owed`, { ...ref, explainedUnits: owed })
          : finding("topup_missing", `refund top-up of ${formatEur(owed)} overdue`, { ...ref, unexplainedUnits: owed }),
      ],
      complete: false,
    };
  }
  if (paid !== owed) {
    return {
      findings: [
        finding("topup_mismatch", `refund top-up ${formatEur(paid)}, expected ${formatEur(owed)}`, {
          ...ref,
          unexplainedUnits: absUnits(paid - owed),
        }),
      ],
      complete: false,
    };
  }
  return { findings: [], complete: buyerNet + paid === exit.toBuyer };
}

function short(s: string): string {
  return s.length > 12 ? `${s.slice(0, 8)}...` : s;
}

// ---------------------------------------------------------------------------
// runOnce: one scheduled pass through the ports
// ---------------------------------------------------------------------------

export interface RunDeps {
  ledger: LedgerSource;
  chain: ChainReader;
  clock: Clock;
  /** Optional: alerts for P1 and P2 findings go here (D7 monitoring hook). */
  sink?: ReportSink;
}

export interface RunOptions {
  /** Last ledger the previous run fully covered; used for the event-gap rule. */
  cursorLedger?: number;
}

/** Result of one pass. `findings` is internal; the daily report aggregates it. */
export interface RunResult {
  startedAt: number;
  finishedAt: number;
  pass: boolean;
  /** Distinct reasons the run failed (blocking kinds, or "unexplained_cents"). */
  failReasons: string[];
  escrowsChecked: number;
  unexplainedUnits: Units;
  unexplainedCents: bigint;
  openValueUnits: Units;
  refundsComplete: number;
  findings: Finding[];
  /** Persist and pass back as `cursorLedger` next time. */
  nextCursorLedger?: number;
}

/** Run one reconciliation pass. Never throws on chain or ledger errors: they become blocking findings. */
export async function runOnce(deps: RunDeps, config: ReconcilerConfig, opts: RunOptions = {}): Promise<RunResult> {
  const startedAt = deps.clock.now();
  const findings: Finding[] = [];
  let nextCursorLedger = opts.cursorLedger;

  // Event coverage: the previous cursor must still be inside retained history.
  try {
    const cov = await deps.chain.getEventCoverage();
    if (opts.cursorLedger !== undefined && opts.cursorLedger + 1 < cov.oldestLedger) {
      findings.push(
        finding(
          "rpc_event_gap",
          `events from ledger ${opts.cursorLedger + 1} to ${cov.oldestLedger - 1} are past the reader's retention`,
        ),
      );
    }
    for (const g of cov.gaps) {
      findings.push(finding("rpc_event_gap", `reader reports missing ledgers ${g.fromLedger}-${g.toLedger}`));
    }
    nextCursorLedger = cov.latestLedger;
  } catch (err) {
    findings.push(finding("read_error", `event coverage: ${errText(err)}`));
  }

  // Both fee accounts must be able to receive EURC, or every exit reverts.
  const feeAccountProblems: string[] = [];
  for (const account of [config.platformAccount, config.trustlessWorkFeeAccount]) {
    try {
      const tl = await deps.chain.getTrustline(account);
      if (!tl.exists || !tl.authorized) {
        feeAccountProblems.push(account);
        findings.push(
          finding(
            "fee_account_no_trustline",
            `fee account ${short(account)} ${tl.exists ? "trustline not authorised" : "has no EURC trustline"}`,
          ),
        );
      }
    } catch (err) {
      findings.push(finding("read_error", `trustline of ${short(account)}: ${errText(err)}`));
    }
  }

  let escrows: ExpectedEscrow[] = [];
  try {
    escrows = await deps.ledger.listEscrows(startedAt);
  } catch (err) {
    findings.push(finding("read_error", `ledger: ${errText(err)}`));
  }

  let platformTransfers: EurcTransfer[] | undefined;
  let openValueUnits = 0n;
  let refundsComplete = 0;
  const ctx: EscrowContext = { config, now: startedAt, feeAccountProblems };

  for (const e of escrows) {
    const ref = { escrowId: e.escrowId, orderRef: e.orderRef };
    try {
      const state = await deps.chain.getEscrowState(e.escrowId);
      if (!state) {
        findings.push(finding("read_error", "escrow not found on chain", ref));
        continue;
      }
      const [balance, transfers] = await Promise.all([
        deps.chain.getBalance(e.escrowId),
        deps.chain.getTransfers(e.escrowId),
      ]);
      const txStatus = new Map<string, TxStatus>();
      for (const exit of e.exits) txStatus.set(exit.txHash, await deps.chain.getTxStatus(exit.txHash));
      if (e.exits.some((x) => x.toBuyer > 0n) && platformTransfers === undefined) {
        platformTransfers = await deps.chain.getTransfers(config.platformAccount);
      }
      const r = reconcileEscrow(
        e,
        { state, balance, transfers, txStatus, platformTransfers: platformTransfers ?? [] },
        ctx,
      );
      findings.push(...r.findings);
      refundsComplete += r.refundsComplete;
      if (!state.flags.released && !state.flags.resolved) openValueUnits += balance.amount;
    } catch (err) {
      findings.push(finding("read_error", errText(err), ref));
    }
  }

  if (openValueUnits > config.openValueCap) {
    findings.push(
      finding("open_value_cap_exceeded", `open escrow value ${formatEur(openValueUnits)} above cap ${formatEur(config.openValueCap)}`),
    );
  }

  const unexplainedUnits = sum(findings.map((f) => f.unexplainedUnits));
  const failReasons = [...new Set(findings.filter((f) => f.blocking).map((f) => f.kind as string))];
  if (unexplainedUnits > 0n) failReasons.push("unexplained_cents");

  if (deps.sink) {
    for (const f of findings) {
      if (f.severity === "P3") continue;
      const alert: Alert = {
        severity: f.severity,
        kind: f.kind,
        message: `${FINDING_KINDS[f.kind].meaning} ${f.message}`,
        at: startedAt,
      };
      if (f.escrowId !== undefined) alert.escrowId = f.escrowId;
      if (f.orderRef !== undefined) alert.orderRef = f.orderRef;
      await deps.sink.alert(alert);
    }
  }

  const result: RunResult = {
    startedAt,
    finishedAt: deps.clock.now(),
    pass: failReasons.length === 0,
    failReasons,
    escrowsChecked: escrows.length,
    unexplainedUnits,
    unexplainedCents: unitsToCentsCeil(unexplainedUnits),
    openValueUnits,
    refundsComplete,
    findings,
  };
  if (nextCursorLedger !== undefined) result.nextCursorLedger = nextCursorLedger;
  return result;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
