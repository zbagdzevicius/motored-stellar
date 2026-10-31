/**
 * Named reconciliation outcomes.
 *
 * Every difference between the expected ledger and the chain is classified
 * into one of these kinds. Each kind has a fixed severity (for alerting) and a
 * `blocking` flag: a blocking finding fails the run even when no cents are
 * unexplained, because it means the reconciliation itself cannot vouch for
 * the result (an event gap, a read error) or a hard control was breached (a
 * cap, a fee account that cannot receive EURC).
 *
 * The first seven kinds are the named failure states (pre-award detection;
 * SCF deliverable D12 bills only the live responses to them).
 */
import type { Severity } from "./ports.js";
import type { Units } from "./units.js";

export type FindingKind =
  // D12 named failure states
  | "release_reverted"
  | "partial_funding"
  | "excess_funding"
  | "sepa_after_expiry"
  | "frozen_balance"
  | "fee_account_no_trustline"
  | "rpc_event_gap"
  // matching outcomes
  | "unexplained_transfer"
  | "missing_transfer"
  | "exit_pending"
  | "topup_pending"
  | "topup_missing"
  | "topup_mismatch"
  // integrity and controls
  | "escrow_mismatch"
  | "ledger_chain_mismatch"
  | "per_order_cap_exceeded"
  | "open_value_cap_exceeded"
  | "read_error";

export interface KindMeta {
  severity: Severity;
  blocking: boolean;
  /** One line for the README, report legend and alert text. */
  meaning: string;
}

export const FINDING_KINDS: Readonly<Record<FindingKind, KindMeta>> = Object.freeze({
  release_reverted: {
    severity: "P1",
    blocking: false,
    meaning: "A submitted release, resolution or withdrawal failed or never landed; the funds are still in the escrow.",
  },
  partial_funding: {
    severity: "P2",
    blocking: false,
    meaning: "The buyer funded less than the escrow amount; the order stays unpaid and is refunded through a dispute.",
  },
  excess_funding: {
    severity: "P2",
    blocking: false,
    meaning: "The escrow holds more than expected (buyer overpaid, third-party dust, or a balance left after release).",
  },
  sepa_after_expiry: {
    severity: "P3",
    blocking: false,
    meaning: "Funds arrived after the order's payment deadline; the buyer keeps or is refunded the EURC.",
  },
  frozen_balance: {
    severity: "P1",
    blocking: false,
    meaning: "The issuer revoked authorisation on the escrow's EURC balance; nothing can move until it is unfrozen.",
  },
  fee_account_no_trustline: {
    severity: "P1",
    blocking: true,
    meaning: "A fee account has no authorised EURC trustline, so every release, resolution and withdrawal reverts.",
  },
  rpc_event_gap: {
    severity: "P1",
    blocking: true,
    meaning: "Event history is incomplete (past RPC retention, an indexer gap, or a balance that net transfers do not explain).",
  },
  unexplained_transfer: {
    severity: "P1",
    blocking: false,
    meaning: "EURC left an escrow in a transaction or amount the ledger does not expect.",
  },
  missing_transfer: {
    severity: "P1",
    blocking: false,
    meaning: "A confirmed exit did not pay a leg the fee arithmetic predicts.",
  },
  exit_pending: {
    severity: "P3",
    blocking: false,
    meaning: "An exit was submitted recently and is not on chain yet (within the grace period).",
  },
  topup_pending: {
    severity: "P3",
    blocking: false,
    meaning: "A refund top-up is owed and still within its grace period.",
  },
  topup_missing: {
    severity: "P2",
    blocking: false,
    meaning: "A refund top-up is owed past its grace period, so the buyer is not yet whole.",
  },
  topup_mismatch: {
    severity: "P2",
    blocking: false,
    meaning: "A refund top-up was sent but its amount differs from the fees deducted from the buyer's leg.",
  },
  escrow_mismatch: {
    severity: "P1",
    blocking: true,
    meaning: "The on-chain escrow's amount, fee, roles or platform differ from the ledger.",
  },
  ledger_chain_mismatch: {
    severity: "P1",
    blocking: true,
    meaning: "The ledger records a confirmed release or resolution the escrow's flags do not show.",
  },
  per_order_cap_exceeded: {
    severity: "P1",
    blocking: true,
    meaning: "An escrow amount is above the per-order cap.",
  },
  open_value_cap_exceeded: {
    severity: "P1",
    blocking: true,
    meaning: "Total EURC held in open escrows is above the open-value cap.",
  },
  read_error: {
    severity: "P1",
    blocking: true,
    meaning: "The chain or the ledger could not be read; the run cannot pass.",
  },
});

/**
 * One classified difference. `explainedUnits` is money accounted for by the
 * classification (for example a partial funding still sitting in the escrow);
 * `unexplainedUnits` is money nothing accounts for. Escrow and order
 * references are for internal alerts only and never reach the daily report.
 */
export interface Finding {
  kind: FindingKind;
  severity: Severity;
  blocking: boolean;
  escrowId?: string;
  orderRef?: string;
  explainedUnits: Units;
  unexplainedUnits: Units;
  message: string;
}

/** Build a finding with the kind's fixed severity and blocking flag. */
export function finding(
  kind: FindingKind,
  message: string,
  opts: { escrowId?: string; orderRef?: string; explainedUnits?: Units; unexplainedUnits?: Units } = {},
): Finding {
  const meta = FINDING_KINDS[kind];
  const f: Finding = {
    kind,
    severity: meta.severity,
    blocking: meta.blocking,
    explainedUnits: opts.explainedUnits ?? 0n,
    unexplainedUnits: opts.unexplainedUnits ?? 0n,
    message,
  };
  if (opts.escrowId !== undefined) f.escrowId = opts.escrowId;
  if (opts.orderRef !== undefined) f.orderRef = opts.orderRef;
  return f;
}
