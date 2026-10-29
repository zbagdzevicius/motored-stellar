// SPDX-License-Identifier: Apache-2.0
//
// Soroban RPC adapters for the Submitter and EventSource ports.
// Transaction polling is ported from the lab's `send`/`sendSoroban` helpers.

import { Account, rpc, type FeeBumpTransaction, type Transaction, type xdr } from '@stellar/stellar-sdk';
import { contractErrorCode } from '../errors.js';
import {
  RPC_MAX_CONTRACT_IDS,
  RPC_MAX_FILTERS,
  RPC_MAX_TOPIC_FILTERS,
  type AuthMode,
  type EventPage,
  type EventQuery,
  type EventSource,
  type RawContractEvent,
  type SimulationOutcome,
  type Submitter,
  type SubmitResult,
} from '../ports.js';

/** The RPC calls `RpcSubmitter` makes; a fake can stand in for tests. */
export type RpcSubmitterServer = Pick<rpc.Server, 'getAccount' | 'getLatestLedger' | 'simulateTransaction' | 'sendTransaction' | 'getTransaction'>;

export interface RpcSubmitterOptions {
  /** Poll interval while waiting for a submitted transaction. Default 1,500 ms. */
  pollMs?: number;
  /**
   * How long to wait when the transaction has no maxTime (timebounds). Default 300,000 ms,
   * the 300 s `buildInvocation` sets. With a maxTime the submitter waits until a ledger
   * closes past it instead.
   */
  maxWaitMs?: number;
  /**
   * Called with the transaction hash before the first `sendTransaction`. Persist it: after a
   * crash, `send` with the same signed transaction (or `status(hash)`) finds the outcome
   * instead of paying twice.
   */
  beforeSubmit?: (hash: string, tx: Transaction | FeeBumpTransaction) => void | Promise<void>;
  /**
   * Resend the same signed envelope after this many NOT_FOUND polls following a PENDING send,
   * in case the mempool dropped it. Default 4 (about 6 s at the default poll interval).
   */
  resendEveryPolls?: number;
  allowHttp?: boolean;
  /** Replaces the RPC client (tests). */
  server?: RpcSubmitterServer;
  /** Clock and sleep (tests). */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Wall-clock slack past maxTime before giving up when no ledger close past it has been seen. */
const MAX_TIME_GRACE_MS = 60_000;

/** NOT_FOUND polls after a PENDING send before the same envelope is resent. */
const DEFAULT_RESEND_EVERY_POLLS = 4;

/** Hex hash of a signed transaction: known before submission, so callers can record it first. */
export function transactionHash(tx: Transaction | FeeBumpTransaction): string {
  return Buffer.from(tx.hash()).toString('hex');
}

/** The transaction's maxTime in Unix seconds, or undefined when it has none. */
export function transactionMaxTime(tx: Transaction | FeeBumpTransaction): number | undefined {
  const inner = 'innerTransaction' in tx ? tx.innerTransaction : tx;
  const max = Number(inner.timeBounds?.maxTime ?? 0);
  return max > 0 ? max : undefined;
}

/** Result code name from a `sendTransaction` ERROR (`txBadSeq`, `txTooLate`, ...), looking inside a fee bump. */
export function sendErrorCode(errorResult: xdr.TransactionResult | undefined): string | undefined {
  if (!errorResult) return undefined;
  try {
    const res = errorResult.result;
    if (res.type === 'txFeeBumpInnerFailed' || res.type === 'txFeeBumpInnerSuccess') return res.innerResultPair.result.result.type;
    return res.type;
  } catch {
    return undefined;
  }
}

/**
 * Submits over Soroban RPC and waits for the outcome.
 *
 * - `TRY_AGAIN_LATER` (queue full or one Soroban tx per account per ledger) is resent, not reported as rejected.
 * - `txBadSeq` is resent while the account's sequence is still below the transaction's (an earlier
 *   transaction from the same account has not landed). Once the sequence is used up the transaction
 *   can never apply: REJECTED with `retryable: true`, so the caller rebuilds and re-signs.
 * - Polling runs until a ledger closes past the transaction's maxTime, not a fixed number of polls.
 *   NOT_FOUND after that is final (TIMEOUT, `retryable: true`); a wall-clock TIMEOUT without that
 *   proof is `retryable: false`, because the transaction may still land.
 * - The hash is computed and handed to `beforeSubmit` before anything is sent, and a hash RPC already
 *   knows returns its recorded outcome, so a retried `send` is idempotent.
 * - A PENDING transaction that stays NOT_FOUND is resent as the same signed envelope (same hash)
 *   every `resendEveryPolls` polls until maxTime, so a mempool eviction does not strand it.
 *
 * This serialises nothing across calls: one sponsor account still needs one submit queue (or
 * channel accounts with the sponsor as fee-bump payer) in the caller.
 */
export class RpcSubmitter implements Submitter {
  readonly server: RpcSubmitterServer;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  constructor(rpcUrl: string, private readonly opts: RpcSubmitterOptions = {}) {
    this.server = opts.server ?? new rpc.Server(rpcUrl, { allowHttp: opts.allowHttp ?? false });
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((s) => setTimeout(s, ms)));
  }

  async getAccount(publicKey: string): Promise<Account> {
    const a = await this.server.getAccount(publicKey);
    return new Account(a.accountId(), a.sequenceNumber());
  }

  async getLatestLedger(): Promise<number> {
    return (await this.server.getLatestLedger()).sequence;
  }

  async simulate(tx: Transaction, authMode?: AuthMode): Promise<SimulationOutcome> {
    // The third argument selects the auth mode (enforce / record / record_allow_nonroot);
    // typed as rpc.Api.SimulationAuthMode in @stellar/stellar-sdk 17.
    const sim = await this.server.simulateTransaction(tx, undefined, authMode);
    if (rpc.Api.isSimulationError(sim)) {
      return { ok: false, error: sim.error, contractErrorCode: contractErrorCode(sim.error) };
    }
    if (rpc.Api.isSimulationRestore(sim)) {
      return { ok: false, error: 'simulation requires a ledger entry restore first' };
    }
    const success = sim as rpc.Api.SimulateTransactionSuccessResponse;
    return {
      ok: true,
      retval: success.result?.retval,
      auth: success.result?.auth ?? [],
      minResourceFee: BigInt(success.minResourceFee),
      prepare: (t: Transaction) => rpc.assembleTransaction(t, success).build(),
    };
  }

  /** The recorded outcome of `hash`, or undefined while RPC does not know it. */
  async status(hash: string): Promise<SubmitResult | undefined> {
    const g = await this.server.getTransaction(hash);
    if (g.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      return { hash, status: 'SUCCESS', returnValue: g.returnValue, feeCharged: BigInt(g.resultXdr.feeCharged) };
    }
    if (g.status === rpc.Api.GetTransactionStatus.FAILED) return { hash, status: 'FAILED' };
    return undefined;
  }

  async send(tx: Transaction | FeeBumpTransaction): Promise<SubmitResult> {
    const hash = transactionHash(tx);
    const maxTime = transactionMaxTime(tx);
    const deadline = maxTime !== undefined ? maxTime * 1000 + MAX_TIME_GRACE_MS : this.now() + (this.opts.maxWaitMs ?? 300_000);
    const pollMs = this.opts.pollMs ?? 1_500;

    const known = await this.status(hash);
    if (known) return known;
    await this.opts.beforeSubmit?.(hash, tx);

    const resendEvery = Math.max(1, this.opts.resendEveryPolls ?? DEFAULT_RESEND_EVERY_POLLS);
    let needSend = true;
    // Once RPC has accepted the envelope, a later send's ERROR proves nothing on its own (the
    // transaction may have applied in the ledger RPC has not ingested yet): only getTransaction,
    // or a ledger closed past maxTime, ends the call.
    let everAccepted = false;
    let notFound = 0;
    while (this.now() < deadline) {
      if (needSend) {
        const r = await this.server.sendTransaction(tx);
        if (r.status === 'PENDING' || r.status === 'DUPLICATE') {
          needSend = false;
          everAccepted = true;
          notFound = 0;
        } else if (r.status === 'ERROR') {
          const code = sendErrorCode(r.errorResult);
          if (everAccepted) {
            needSend = false;
            notFound = 0;
          } else if (code === 'txBadSeq') {
            // Landed in the meantime (a resend after it applied reports txBadSeq)?
            const landed = await this.status(hash);
            if (landed) return landed;
            if (await this.sequenceUsed(tx)) return { hash, status: 'REJECTED', reason: code, retryable: true };
          } else {
            return { hash, status: 'REJECTED', reason: code, retryable: code === 'txTooLate' };
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
      if (g.status === rpc.Api.GetTransactionStatus.SUCCESS) {
        return { hash, status: 'SUCCESS', returnValue: g.returnValue, feeCharged: BigInt(g.resultXdr.feeCharged) };
      }
      if (g.status === rpc.Api.GetTransactionStatus.FAILED) return { hash, status: 'FAILED' };
      // NOT_FOUND: final once a ledger has closed past maxTime.
      if (maxTime !== undefined && Number(g.latestLedgerCloseTime) > maxTime) return { hash, status: 'TIMEOUT', reason: 'expired', retryable: true };
      // Still NOT_FOUND after a PENDING send: the mempool may have dropped it (eviction, node
      // restart). Resend the same signed envelope: same hash, so it cannot apply twice; RPC
      // answers DUPLICATE while it is still queued.
      if (++notFound >= resendEvery) needSend = true;
    }
    return { hash, status: 'TIMEOUT', retryable: false };
  }

  /** True when the source account's sequence has reached the transaction's: it can never apply. */
  private async sequenceUsed(tx: Transaction | FeeBumpTransaction): Promise<boolean> {
    const inner = 'innerTransaction' in tx ? tx.innerTransaction : tx;
    const account = await this.server.getAccount(inner.source);
    return BigInt(account.sequenceNumber()) >= BigInt(inner.sequence);
  }
}

/** Shape of an RPC event as returned by the SDK (topic/value already parsed). */
interface SdkEvent {
  id: string;
  ledger: number;
  ledgerClosedAt: string;
  contractId?: { contractId(): string } | string;
  txHash: string;
  topic: xdr.ScVal[];
  value: xdr.ScVal;
  inSuccessfulContractCall?: boolean;
}

/**
 * `getEvents` over Soroban RPC. Events older than the RPC's retention window are gone: persist what you read.
 * Enforces RPC's limits: at most 5 contract ids (callers split larger sets), topic filters split into
 * groups of 5 (one RPC filter each), and a start ledger that defaults to the oldest retained one.
 */
export class RpcEventSource implements EventSource {
  constructor(private readonly server: Pick<rpc.Server, 'getEvents' | 'getHealth'>) {}

  async ledgerRange(): Promise<{ oldestLedger: number; latestLedger: number }> {
    const h = await this.server.getHealth();
    return { oldestLedger: h.oldestLedger, latestLedger: h.latestLedger };
  }

  async getEvents(q: EventQuery): Promise<EventPage> {
    if (q.contractIds.length > RPC_MAX_CONTRACT_IDS) throw new RangeError(`getEvents: at most ${RPC_MAX_CONTRACT_IDS} contract ids per filter (got ${q.contractIds.length})`);
    const topicGroups: Array<string[][] | undefined> = [];
    if (!q.topics || q.topics.length === 0) topicGroups.push(undefined);
    else for (let i = 0; i < q.topics.length; i += RPC_MAX_TOPIC_FILTERS) topicGroups.push(q.topics.slice(i, i + RPC_MAX_TOPIC_FILTERS));
    if (topicGroups.length > RPC_MAX_FILTERS) throw new RangeError(`getEvents: at most ${RPC_MAX_FILTERS * RPC_MAX_TOPIC_FILTERS} topic filters`);
    const filters = topicGroups.map((topics) => ({ type: 'contract' as const, contractIds: q.contractIds, ...(topics ? { topics } : {}) }));
    // RPC takes either a cursor or a start ledger, not both; ledger 0 is outside every retention window.
    const req = q.cursor
      ? { filters, cursor: q.cursor, limit: q.limit ?? 100 }
      : { filters, startLedger: q.startLedger ?? (await this.ledgerRange()).oldestLedger, limit: q.limit ?? 100 };
    const res = (await this.server.getEvents(req as Parameters<rpc.Server['getEvents']>[0])) as unknown as {
      events: SdkEvent[];
      cursor?: string;
      latestLedger?: number;
      oldestLedger?: number;
    };
    const events: RawContractEvent[] = res.events.map((e) => ({
      id: e.id,
      ledger: e.ledger,
      ledgerClosedAt: e.ledgerClosedAt,
      contractId: typeof e.contractId === 'string' ? e.contractId : (e.contractId?.contractId() ?? ''),
      txHash: e.txHash,
      topic: e.topic.map((t) => t.toXDR('base64')),
      value: e.value.toXDR('base64'),
      inSuccessfulContractCall: e.inSuccessfulContractCall,
    }));
    return { events, cursor: res.cursor ?? events.at(-1)?.id ?? q.cursor, latestLedger: res.latestLedger, oldestLedger: res.oldestLedger };
  }
}
