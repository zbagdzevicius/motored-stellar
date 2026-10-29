// RegistryClient over Soroban RPC. Reads (verify, anchored_at) are simulations from a
// random throwaway source: nothing is signed or sent. Writes (anchor, revoke) are
// built, simulated, assembled, signed through the Signer port and sent through the
// Submitter port. Ported from the lab scripts (anchor call, send loop) and an
// earlier read-only verifier (simulation only).
import {
  Account,
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  type FeeBumpTransaction,
  type Transaction,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { toU64 } from "./bytes.js";
import { MAX_DEPTH } from "./merkle.js";
import {
  type RegistryClient,
  RegistryError,
  RegistryErrorCode,
  type Signer,
  type SubmitResult,
  type Submitter,
  type WriteReceipt,
} from "./ports.js";

/** The subset of `rpc.Server` this module uses (injectable for tests). */
export type SorobanRpc = Pick<rpc.Server, "simulateTransaction" | "getAccount" | "sendTransaction" | "getTransaction">;

/** Public testnet defaults. Mainnet is deliberately not offered as a default here. */
export const TESTNET = { rpcUrl: "https://soroban-testnet.stellar.org", networkPassphrase: Networks.TESTNET } as const;

const u64 = (n: bigint) => nativeToScVal(toU64(n), { type: "u64" });
const u32 = (n: number) => nativeToScVal(n, { type: "u32" });
const bytes = (b: Uint8Array) => xdr.ScVal.scvBytes(Buffer.from(b));

/** Extracts the contract error code from a simulation error string, e.g. "Error(Contract, #5)". */
export function contractErrorCode(message: string): number | undefined {
  const m = /Error\(Contract, #(\d+)\)/.exec(message);
  return m ? Number(m[1]) : undefined;
}

function toRegistryError(message: string): Error {
  const code = contractErrorCode(message);
  return code !== undefined && code in RegistryErrorCode
    ? new RegistryError(code as RegistryErrorCode, message.slice(0, 200))
    : new Error(`simulation failed: ${message.slice(0, 300)}`);
}

export interface SorobanRegistryOptions {
  rpc: SorobanRpc;
  networkPassphrase: string;
  /** Claim registry contract ID (C...). */
  contractId: string;
  /** Issuer key, for `anchor`. */
  issuer?: Signer;
  /** Offline revoker key, for `revoke`. */
  revoker?: Signer;
  submitter?: Submitter;
  /** Inclusion fee in stroops for writes (resource fee is added by simulation). Default BASE_FEE. */
  fee?: string;
}

export class SorobanRegistryClient implements RegistryClient {
  private readonly contract: Contract;
  constructor(private readonly o: SorobanRegistryOptions) {
    this.contract = new Contract(o.contractId);
  }

  private async read(method: string, args: xdr.ScVal[]): Promise<unknown> {
    // Simulation needs a source account but never its secret; a random one is fine.
    const source = new Account(Keypair.random().publicKey(), "0");
    const tx = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: this.o.networkPassphrase })
      .addOperation(this.contract.call(method, ...args))
      .setTimeout(30)
      .build();
    const sim = await this.o.rpc.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) throw toRegistryError(sim.error);
    if (!sim.result) throw new Error(`${method}: simulation returned no result`);
    return scValToNative(sim.result.retval);
  }

  private async write(signer: Signer | undefined, method: string, args: xdr.ScVal[]): Promise<WriteReceipt> {
    if (!signer) throw new Error(`${method}: no signer configured`);
    if (!this.o.submitter) throw new Error(`${method}: no submitter configured`);
    const acct = await this.o.rpc.getAccount(signer.publicKey());
    const tx0 = new TransactionBuilder(acct, { fee: this.o.fee ?? BASE_FEE, networkPassphrase: this.o.networkPassphrase })
      .addOperation(this.contract.call(method, ...args))
      .setTimeout(300)
      .build();
    const sim = await this.o.rpc.simulateTransaction(tx0);
    if (rpc.Api.isSimulationError(sim)) throw toRegistryError(sim.error);
    const tx = rpc.assembleTransaction(tx0, sim).build();
    await signInto(tx, signer);
    const r = await this.o.submitter.send(tx);
    if (r.status !== "SUCCESS") {
      const why = [r.reason, r.retryable === undefined ? undefined : r.retryable ? "safe to rebuild" : "may still land"].filter(Boolean).join(", ");
      throw new Error(`${method}: transaction ${r.hash} ${r.status}${why ? ` (${why})` : ""}`);
    }
    return { txHash: r.hash };
  }

  anchor(batchId: bigint, root: Uint8Array): Promise<WriteReceipt> {
    if (root.length !== 32) throw new TypeError("root must be 32 bytes");
    return this.write(this.o.issuer, "anchor", [u64(batchId), bytes(root)]);
  }

  revoke(batchId: bigint): Promise<WriteReceipt> {
    return this.write(this.o.revoker, "revoke", [u64(batchId)]);
  }

  async anchoredAt(batchId: bigint): Promise<bigint> {
    const v = await this.read("anchored_at", [u64(batchId)]);
    if (typeof v !== "bigint" && typeof v !== "number") throw new Error("anchored_at: unexpected return value");
    return BigInt(v);
  }

  async verify(batchId: bigint, leaf: Uint8Array, proof: Uint8Array[], index: number): Promise<boolean> {
    if (proof.length > MAX_DEPTH) throw new RegistryError(RegistryErrorCode.ProofTooLong);
    const v = await this.read("verify", [u64(batchId), bytes(leaf), xdr.ScVal.scvVec(proof.map(bytes)), u32(index)]);
    return v === true;
  }
}

/** Adds the signer's signature over the transaction hash. */
export async function signInto(tx: Transaction, signer: Signer): Promise<void> {
  const sig = await signer.signTxHash(tx.hash());
  tx.addSignature(signer.publicKey(), Buffer.from(sig).toString("base64"));
}

/** The RPC calls `RpcSubmitter` makes; a fake can stand in for tests. */
export type RpcSubmitterServer = Pick<rpc.Server, "sendTransaction" | "getTransaction" | "getAccount">;

export interface RpcSubmitterOptions {
  /** Poll interval while waiting for a submitted transaction. Default 1,500 ms. */
  pollMs?: number;
  /** How long to wait when the transaction has no maxTime (timebounds). Default 300,000 ms. */
  maxWaitMs?: number;
  /** Resend the same envelope after this many NOT_FOUND polls following a PENDING send. Default 4. */
  resendEveryPolls?: number;
  /**
   * Called with the transaction hash before the first `sendTransaction`. Persist it: after a
   * crash, `send` with the same signed transaction (or `status(hash)`) finds the outcome
   * instead of anchoring or revoking twice.
   */
  beforeSubmit?: (hash: string, tx: Transaction | FeeBumpTransaction) => void | Promise<void>;
  /** Clock and sleep (tests). */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Wall-clock slack past maxTime before giving up when no ledger close past it has been seen. */
const MAX_TIME_GRACE_MS = 60_000;

/** Hex hash of a signed transaction: known before submission, so callers can record it first. */
export function transactionHash(tx: Transaction | FeeBumpTransaction): string {
  return Buffer.from(tx.hash()).toString("hex");
}

/** The transaction's maxTime in Unix seconds, or undefined when it has none. */
export function transactionMaxTime(tx: Transaction | FeeBumpTransaction): number | undefined {
  const inner = "innerTransaction" in tx ? tx.innerTransaction : tx;
  const max = Number(inner.timeBounds?.maxTime ?? 0);
  return max > 0 ? max : undefined;
}

/** Result code name from a `sendTransaction` ERROR (`txBadSeq`, `txTooLate`, ...), looking inside a fee bump. */
export function sendErrorCode(errorResult: xdr.TransactionResult | undefined): string | undefined {
  if (!errorResult) return undefined;
  try {
    const res = errorResult.result;
    if (res.type === "txFeeBumpInnerFailed" || res.type === "txFeeBumpInnerSuccess") return res.innerResultPair.result.result.type;
    return res.type;
  } catch {
    return undefined;
  }
}

/**
 * Submitter over Soroban RPC: send, then poll getTransaction until it lands. Same rules as
 * the escrow package's `RpcSubmitter` (packages/escrow/src/adapters/rpc.ts); keep them aligned:
 *
 * - `TRY_AGAIN_LATER` is resent, not reported as rejected.
 * - `txBadSeq` is resent while the account's sequence is still below the transaction's; once
 *   the sequence is used up (and the hash is not on the ledger) it is REJECTED, `retryable: true`.
 * - Polling runs until a ledger closes past the transaction's maxTime (TIMEOUT `expired`,
 *   `retryable: true`); a wall-clock TIMEOUT without that proof is `retryable: false`.
 * - The hash is computed and handed to `beforeSubmit` before anything is sent, and a hash RPC
 *   already knows returns its recorded outcome, so a retried `send` is idempotent.
 * - A PENDING transaction that stays NOT_FOUND is resent as the same signed envelope (same
 *   hash) every `resendEveryPolls` polls until maxTime, so a mempool eviction does not strand it.
 */
export class RpcSubmitter implements Submitter {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  constructor(
    private readonly server: RpcSubmitterServer,
    private readonly opts: RpcSubmitterOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((s) => setTimeout(s, ms)));
  }

  /** The recorded outcome of `hash`, or undefined while RPC does not know it. */
  async status(hash: string): Promise<SubmitResult | undefined> {
    const g = await this.server.getTransaction(hash);
    if (g.status === rpc.Api.GetTransactionStatus.SUCCESS) return { hash, status: "SUCCESS" };
    if (g.status === rpc.Api.GetTransactionStatus.FAILED) return { hash, status: "FAILED" };
    return undefined;
  }

  async send(tx: Transaction | FeeBumpTransaction): Promise<SubmitResult> {
    const hash = transactionHash(tx);
    const maxTime = transactionMaxTime(tx);
    const deadline = maxTime !== undefined ? maxTime * 1000 + MAX_TIME_GRACE_MS : this.now() + (this.opts.maxWaitMs ?? 300_000);
    const pollMs = this.opts.pollMs ?? 1_500;
    const resendEvery = Math.max(1, this.opts.resendEveryPolls ?? 4);

    const known = await this.status(hash);
    if (known) return known;
    await this.opts.beforeSubmit?.(hash, tx);

    let needSend = true;
    // After RPC has accepted the envelope once, a later send's ERROR proves nothing on its own:
    // only getTransaction, or a ledger closed past maxTime, ends the call.
    let everAccepted = false;
    let notFound = 0;
    while (this.now() < deadline) {
      if (needSend) {
        const r = await this.server.sendTransaction(tx);
        if (r.status === "PENDING" || r.status === "DUPLICATE") {
          needSend = false;
          everAccepted = true;
          notFound = 0;
        } else if (r.status === "ERROR") {
          const code = sendErrorCode(r.errorResult);
          if (everAccepted) {
            needSend = false;
            notFound = 0;
          } else if (code === "txBadSeq") {
            const landed = await this.status(hash);
            if (landed) return landed;
            if (await this.sequenceUsed(tx)) return { hash, status: "REJECTED", reason: code, retryable: true };
          } else {
            return { hash, status: "REJECTED", reason: code, retryable: code === "txTooLate" };
          }
        }
        if (needSend) {
          // TRY_AGAIN_LATER, or txBadSeq behind an earlier transaction: wait and resend.
          await this.sleep(pollMs);
          continue;
        }
      }
      await this.sleep(pollMs);
      const g = await this.server.getTransaction(hash);
      if (g.status === rpc.Api.GetTransactionStatus.SUCCESS) return { hash, status: "SUCCESS" };
      if (g.status === rpc.Api.GetTransactionStatus.FAILED) return { hash, status: "FAILED" };
      if (maxTime !== undefined && Number(g.latestLedgerCloseTime) > maxTime) return { hash, status: "TIMEOUT", reason: "expired", retryable: true };
      // NOT_FOUND after PENDING: the mempool may have dropped it; resend the same envelope.
      if (++notFound >= resendEvery) needSend = true;
    }
    return { hash, status: "TIMEOUT", retryable: false };
  }

  /** True when the source account's sequence has reached the transaction's: it can never apply. */
  private async sequenceUsed(tx: Transaction | FeeBumpTransaction): Promise<boolean> {
    const inner = "innerTransaction" in tx ? tx.innerTransaction : tx;
    const account = await this.server.getAccount(inner.source);
    return BigInt(account.sequenceNumber()) >= BigInt(inner.sequence);
  }
}
