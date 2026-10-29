// Ports: the seams where an operator's own system plugs into the claims package.
// Every port has an in-memory implementation in ./memory.ts, used by the tests and
// by examples/order-flow.
//
// Signer, Submitter and Clock are the same roles as in @motored-stellar/escrow.
// They are declared here structurally (only the members this package calls) so the
// claims package carries no dependency on the escrow package; any escrow-port
// implementation with these members satisfies them.
// Keep these member names aligned with packages/escrow/src/ports.ts.
import type { Transaction } from "@stellar/stellar-sdk";

/** Wall clock in unix seconds. */
export interface Clock {
  nowSeconds(): number;
}

/** Signs a transaction hash with the ed25519 key behind `publicKey()` (G...). */
export interface Signer {
  publicKey(): string;
  /** Returns the raw 64-byte ed25519 signature of the 32-byte transaction hash. */
  signTxHash(hash: Uint8Array): Promise<Uint8Array>;
}

export interface SubmitResult {
  hash: string;
  status: "SUCCESS" | "FAILED" | "REJECTED" | "TIMEOUT";
}

/** Sends a signed transaction and waits for its outcome. */
export interface Submitter {
  send(tx: Transaction): Promise<SubmitResult>;
}

/**
 * One delivered parcel, as reported by the operator's carrier integration.
 * The carrier's tracking client is NOT part of this package; it lives in the
 * operator's own system and feeds this port.
 */
export interface DeliveredEvent {
  /** Escrow contract address (C...) the order is paid into. */
  escrow: string;
  /** The order's random 32-byte reference. */
  orderRef: Uint8Array;
  /** Parcel number exactly as the carrier reports it. Never leaves the operator. */
  parcelNumber: string;
  /** Carrier's delivered status text, verbatim. */
  carrierStatusText: string;
  /** Carrier's event timestamp text, verbatim (hashed into carrier_event_ref). */
  carrierDateTime: string;
  /** Language the status text was requested in. Default "en". */
  lang?: string;
  /** Delivery time parsed from `carrierDateTime`, unix seconds. */
  deliveredAt: number | bigint;
}

/**
 * Source of delivered events. Implementations decide which carrier statuses count
 * as delivered (for example only "delivered to consignee" and "picked up from a
 * pickup point") and must only emit events whose timestamp parsed.
 */
export interface DeliveryOracle {
  /** Events after `cursor` (opaque; undefined = from the start), plus the next cursor. */
  poll(cursor?: string): Promise<{ events: DeliveredEvent[]; cursor?: string }>;
}

/** Per-order secret salts for parcel commitments. Kept off-chain, never published. */
export interface SaltStore {
  /** Returns the order's salt, creating and persisting a random 32-byte one on first use. */
  getOrCreate(orderRef: Uint8Array): Promise<Uint8Array>;
  get(orderRef: Uint8Array): Promise<Uint8Array | undefined>;
}

/** Transaction receipt of a registry write. In-memory registries return a synthetic hash. */
export interface WriteReceipt {
  txHash: string;
}

/**
 * The on-chain claim registry (contracts/claim-registry). Errors are thrown as
 * {@link RegistryError} with the contract's error codes.
 */
export interface RegistryClient {
  /** Write-once anchor of a batch root (issuer-authorised). */
  anchor(batchId: bigint, root: Uint8Array): Promise<WriteReceipt>;
  /** True iff the batch exists, is not revoked and the proof leads to its root. */
  verify(batchId: bigint, leaf: Uint8Array, proof: Uint8Array[], index: number): Promise<boolean>;
  /** Ledger timestamp of the anchor. Throws NoRoot or Revoked. */
  anchoredAt(batchId: bigint): Promise<bigint>;
  /** Permanently revokes a batch (revoker-authorised). */
  revoke(batchId: bigint): Promise<WriteReceipt>;
}

/** Registry contract error codes (`contracts/claim-registry` `Error`). */
export enum RegistryErrorCode {
  NotInitialized = 2,
  RootExists = 3,
  ProofTooLong = 4,
  NoRoot = 5,
  Revoked = 6,
}

export class RegistryError extends Error {
  constructor(
    readonly code: RegistryErrorCode,
    detail?: string,
  ) {
    super(`registry error ${RegistryErrorCode[code] ?? code} (#${code})${detail ? `: ${detail}` : ""}`);
    this.name = "RegistryError";
  }
}

/** A claim waiting for the next batch. */
export interface PendingClaim {
  escrow: string;
  orderRef: Uint8Array;
  parcelsCommit: Uint8Array;
  carrierEventRef: Uint8Array;
  deliveredAt: bigint;
  leaf: Uint8Array;
}

/** A claim in an anchored batch: everything the guard's `ResolveSeller` signature needs. */
export interface AnchoredClaim extends PendingClaim {
  batchId: bigint;
  index: number;
  proof: Uint8Array[];
  root: Uint8Array;
  anchorTx: string;
}

/** Persistence for the anchoring job. */
export interface ClaimStore {
  /** Adds a pending claim; returns false if a claim for this escrow already exists (pending or anchored). */
  addPending(c: PendingClaim): Promise<boolean>;
  pending(): Promise<PendingClaim[]>;
  /** Moves claims from pending to anchored, atomically in a real store. */
  markAnchored(claims: AnchoredClaim[]): Promise<void>;
  anchoredFor(escrow: string): Promise<AnchoredClaim | undefined>;
  lastBatchId(): Promise<bigint | undefined>;
  cursor(): Promise<string | undefined>;
  setCursor(cursor: string | undefined): Promise<void>;
}
