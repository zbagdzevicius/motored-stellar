/**
 * Ports: the small interfaces where a host system plugs into the reconciler.
 *
 * The reconciler never talks to a database, a scheduler or a specific RPC
 * provider directly. A marketplace supplies its expected ledger through
 * `LedgerSource`, the chain is read through `ChainReader`, results leave
 * through `ReportSink`, and time comes from `Clock`. Every port has an
 * in-memory implementation in `memory.ts`, used by the tests.
 *
 * All amounts are EURC base units (7 decimals) as `bigint`. All times are
 * epoch milliseconds, matching the `Clock` shape used across this repo.
 */
import type { DailyReport } from "./report.js";
import type { Units } from "./units.js";

/** Wall clock, injectable for tests (epoch milliseconds). */
export interface Clock {
  now(): number;
}

// ---------------------------------------------------------------------------
// Expected ledger (what the marketplace believes)
// ---------------------------------------------------------------------------

/**
 * Lifecycle of an escrow as the marketplace's order ledger records it.
 *
 * - `awaiting_funds`: escrow created, buyer has not paid.
 * - `funded`: buyer's own funding of the full amount is recorded.
 * - `release_submitted` / `released`: a release transaction was submitted /
 *   confirmed.
 * - `disputed`: a dispute is open (buyer, seller or platform).
 * - `resolution_submitted` / `resolved`: a resolution was submitted / confirmed.
 * - `cancelled` / `expired`: the order is closed without payment.
 */
export type ExpectedStatus =
  | "awaiting_funds"
  | "funded"
  | "release_submitted"
  | "released"
  | "disputed"
  | "resolution_submitted"
  | "resolved"
  | "cancelled"
  | "expired";

/** An exit the platform submitted: release, resolution or excess withdrawal. */
export interface ExpectedExit {
  kind: "release" | "resolution" | "withdrawal";
  /** Hash of the submitted transaction. */
  txHash: string;
  /** When it was submitted (epoch ms). */
  submittedAt: number;
  /** Gross amount meant for the buyer (0 on a release). */
  toBuyer: Units;
  /** Gross amount meant for the seller (escrow amount on a release). */
  toSeller: Units;
}

/** A refund top-up the platform recorded for an exit that paid the buyer. */
export interface ExpectedTopUp {
  /** The exit (resolution or withdrawal) this top-up completes. */
  exitTxHash: string;
  /** Hash of the top-up payment, once sent. */
  txHash?: string;
}

/** A bank (SEPA) deposit routed through an on-ramp into the buyer's wallet. */
export interface ExpectedRampDeposit {
  amount: Units;
  /** When the EURC arrived in the buyer's wallet (epoch ms). */
  arrivedAt: number;
}

/** One escrow as the order ledger expects it. */
export interface ExpectedEscrow {
  /** Escrow contract ID (C...). */
  escrowId: string;
  /**
   * Opaque order reference in the host system. Used only in internal alerts;
   * never written to the daily report.
   */
  orderRef: string;
  /** Buyer wallet (G...), the escrow's approver. */
  buyer: string;
  /** Seller wallet (G...), the escrow's receiver. */
  seller: string;
  /** Escrow amount. */
  amount: Units;
  /** Platform fee in basis points, fixed when the escrow was created. */
  platformFeeBps: number;
  status: ExpectedStatus;
  /** Payment deadline (epoch ms); funding after it is "SEPA after expiry". */
  paymentDeadline?: number;
  exits: ExpectedExit[];
  topUps: ExpectedTopUp[];
  rampDeposits?: ExpectedRampDeposit[];
}

/** Supplies the expected ledger. */
export interface LedgerSource {
  /**
   * Every escrow that is still open, plus every escrow closed recently enough
   * that its exits and top-ups still need checking. The host decides "recent".
   */
  listEscrows(asOf: number): Promise<ExpectedEscrow[]>;
}

// ---------------------------------------------------------------------------
// Chain (what actually happened)
// ---------------------------------------------------------------------------

/** Trustless Work escrow flags as stored in the escrow contract. */
export interface EscrowFlags {
  disputed: boolean;
  released: boolean;
  resolved: boolean;
}

/** The fields of a Trustless Work escrow the reconciler checks. */
export interface EscrowChainState {
  amount: Units;
  platformFeeBps: number;
  approver: string;
  receiver: string;
  platform: string;
  flags: EscrowFlags;
  /** True when the (single) milestone is approved by the buyer. */
  milestoneApproved: boolean;
}

/** An EURC balance held by an account or contract. */
export interface EurcBalance {
  amount: Units;
  /**
   * False when the issuer has revoked authorisation on this balance (a
   * "frozen" balance). A frozen balance cannot be moved by anyone.
   */
  authorized: boolean;
}

/** One EURC transfer, from SAC `transfer` events or an indexer. */
export interface EurcTransfer {
  txHash: string;
  ledger: number;
  /** Ledger close time (epoch ms). */
  closedAt: number;
  from: string;
  to: string;
  amount: Units;
}

/** Trustline state of a classic account for EURC. */
export interface TrustlineState {
  exists: boolean;
  authorized: boolean;
}

/** Final state of a submitted transaction. */
export type TxStatus = "success" | "failed" | "not_found";

/**
 * How much event history the reader can vouch for. `gaps` lists ledger ranges
 * the reader knows it is missing (an indexer can report these; plain RPC
 * reports none but has a retention floor, `oldestLedger`).
 */
export interface EventCoverage {
  oldestLedger: number;
  latestLedger: number;
  gaps: Array<{ fromLedger: number; toLedger: number }>;
}

/** Reads chain state. Implementations: `InMemoryChainReader`, `RpcChainReader`. */
export interface ChainReader {
  getEscrowState(escrowId: string): Promise<EscrowChainState | null>;
  getBalance(holder: string): Promise<EurcBalance>;
  /** Every EURC transfer into or out of `holder` the reader knows of. */
  getTransfers(holder: string): Promise<EurcTransfer[]>;
  getTxStatus(txHash: string): Promise<TxStatus>;
  getTrustline(account: string): Promise<TrustlineState>;
  getEventCoverage(): Promise<EventCoverage>;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export type Severity = "P1" | "P2" | "P3";

/**
 * An internal alert. Alerts may name an escrow ID and an order reference so an
 * operator can act; they belong in a private channel, never in the public
 * daily report.
 */
export interface Alert {
  severity: Severity;
  kind: string;
  message: string;
  escrowId?: string;
  orderRef?: string;
  at: number;
}

/** Where results go. Implementations: in-memory, console, file. */
export interface ReportSink {
  /** Publish a daily aggregate report (no per-order data). */
  writeDaily(report: DailyReport): Promise<void>;
  /** Raise an internal alert (D7 monitoring hook). */
  alert(alert: Alert): Promise<void>;
}
