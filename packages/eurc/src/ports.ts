/**
 * Ports: the small interfaces where a host system (a marketplace backend, a
 * wallet service) plugs into this package. Each port has an in-memory
 * implementation in `memory.ts` used by the tests and the demos.
 *
 * The Signer, Submitter and Clock shapes match the shared ports described in
 * the repo README (packages/escrow/src/ports.ts); they are declared here too so
 * that this package has no workspace dependency and can be used on its own.
 */
import type { FeeBumpTransaction, Transaction } from "@stellar/stellar-sdk";

/** Signs a 32-byte transaction hash with one ed25519 key. */
export interface Signer {
  /** G... public key of the signing account. */
  publicKey(): string;
  /**
   * Return the raw 64-byte ed25519 signature over `txHash`. Embedded-wallet
   * providers that sign raw hashes (for example a Tier 2 chain integration)
   * implement this directly; the caller attaches the signature.
   *
   * Same shape as `Signer` in @motored-stellar/escrow and @motored-stellar/claims
   * (Uint8Array in and out), so one signer object can serve all three packages.
   */
  signTxHash(txHash: Uint8Array): Promise<Uint8Array>;
}

/** Result of a simulation, reduced to what the fee-bump service needs. */
export interface SimulationOutcome {
  readonly ok: boolean;
  /** Minimum resource fee in stroops, when `ok`. */
  readonly minResourceFee?: string;
  /** Error text from the RPC, when not `ok`. */
  readonly error?: string;
}

/** Result of a submission. */
export interface SubmitOutcome {
  readonly ok: boolean;
  /** Transaction hash (the outer hash for a fee-bump). */
  readonly hash: string;
  /** Result codes or an error string when not `ok`. */
  readonly error?: string;
}

/** Submits transactions and simulates Soroban calls. */
export interface Submitter {
  readonly networkPassphrase: string;
  simulate(tx: Transaction): Promise<SimulationOutcome>;
  submit(tx: Transaction | FeeBumpTransaction): Promise<SubmitOutcome>;
}

/** One trustline (or the native balance) as seen on an account. */
export interface BalanceLine {
  /** "native" for XLM, otherwise the asset code. */
  readonly assetCode: string;
  /** Undefined for XLM. */
  readonly assetIssuer?: string;
  readonly balance: string;
  /** Sponsor of the trustline reserve, when sponsored. */
  readonly sponsor?: string;
  /** False when the issuer has frozen (deauthorised) the trustline. */
  readonly authorized?: boolean;
}

/** Account state needed for trustline and sponsorship checks. */
export interface AccountSnapshot {
  readonly accountId: string;
  /** Current sequence number, as a decimal string. */
  readonly sequence: string;
  readonly balances: readonly BalanceLine[];
  /** Sponsor of the account's base reserve, when sponsored. */
  readonly sponsor?: string;
}

/** Reads account state (Horizon in production). */
export interface AccountReader {
  /** Null when the account does not exist on the ledger. */
  loadAccount(accountId: string): Promise<AccountSnapshot | null>;
}

/** Where a seller's off-ramp payment may go (a ramp provider deposit address). */
export interface RampDestination {
  readonly address: string;
  /**
   * Memo the ramp requires, if any. `value` is the text, the decimal id, or
   * the 32-byte hash as lowercase hex.
   *
   * TODO(verify, D5): which memo type the ramp provider issues for Stellar
   * deposit instructions (see packages/ramps).
   */
  readonly memo?: { readonly type: "text" | "id" | "hash"; readonly value: string };
}

/**
 * The host's view of its own users' wallets. The fee-bump service only pays
 * for wallets the host registered, and only for actions on that wallet's own
 * escrows.
 */
export interface WalletRegistry {
  isRegistered(account: string): Promise<boolean>;
  /** C... ids of escrows in which this wallet is the buyer or the seller. */
  escrowsOf(account: string): Promise<readonly string[]>;
  /** Stored off-ramp destination of this wallet, or null. */
  rampDestinationOf(account: string): Promise<RampDestination | null>;
}

/** Per-wallet rate limiting for sponsored submissions. */
export interface RateLimiter {
  /** Consume one unit for `key`; false when the limit is reached. */
  take(key: string): Promise<boolean>;
}

/** Wall clock, injectable for tests. */
export interface Clock {
  now(): number;
}
