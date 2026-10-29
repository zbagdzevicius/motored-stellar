// SPDX-License-Identifier: Apache-2.0
//
// Soroban RPC adapters for the Submitter and EventSource ports.
// Transaction polling is ported from the lab's `send`/`sendSoroban` helpers.

import { Account, rpc, type FeeBumpTransaction, type Transaction, type xdr } from '@stellar/stellar-sdk';
import { contractErrorCode } from '../errors.js';
import type { AuthMode, EventPage, EventQuery, EventSource, RawContractEvent, SimulationOutcome, Submitter, SubmitResult } from '../ports.js';

export interface RpcSubmitterOptions {
  /** Poll interval while waiting for a submitted transaction. Default 1,500 ms. */
  pollMs?: number;
  /** Maximum polls before reporting TIMEOUT. Default 40. */
  maxPolls?: number;
  allowHttp?: boolean;
}

export class RpcSubmitter implements Submitter {
  readonly server: rpc.Server;
  constructor(rpcUrl: string, private readonly opts: RpcSubmitterOptions = {}) {
    this.server = new rpc.Server(rpcUrl, { allowHttp: opts.allowHttp ?? false });
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

  async send(tx: Transaction | FeeBumpTransaction): Promise<SubmitResult> {
    const r = await this.server.sendTransaction(tx);
    if (r.status === 'ERROR' || r.status === 'TRY_AGAIN_LATER') return { hash: r.hash, status: 'REJECTED' };
    for (let i = 0; i < (this.opts.maxPolls ?? 40); i++) {
      await new Promise((s) => setTimeout(s, this.opts.pollMs ?? 1_500));
      const g = await this.server.getTransaction(r.hash);
      if (g.status === rpc.Api.GetTransactionStatus.NOT_FOUND) continue;
      if (g.status === rpc.Api.GetTransactionStatus.SUCCESS) {
        return {
          hash: r.hash,
          status: 'SUCCESS',
          returnValue: g.returnValue,
          feeCharged: BigInt(g.resultXdr.feeCharged),
        };
      }
      return { hash: r.hash, status: 'FAILED' };
    }
    return { hash: r.hash, status: 'TIMEOUT' };
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

/** `getEvents` over Soroban RPC. Events older than the RPC's retention window are gone: persist what you read. */
export class RpcEventSource implements EventSource {
  constructor(private readonly server: rpc.Server) {}

  async getEvents(q: EventQuery): Promise<EventPage> {
    const filters = [{ type: 'contract' as const, contractIds: q.contractIds, ...(q.topics ? { topics: q.topics } : {}) }];
    // RPC takes either a cursor or a start ledger, not both.
    const req = q.cursor
      ? { filters, cursor: q.cursor, limit: q.limit ?? 100 }
      : { filters, startLedger: q.startLedger ?? 0, limit: q.limit ?? 100 };
    const res = (await this.server.getEvents(req as Parameters<rpc.Server['getEvents']>[0])) as unknown as {
      events: SdkEvent[];
      cursor?: string;
      latestLedger?: number;
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
    return { events, cursor: res.cursor ?? events.at(-1)?.id ?? q.cursor, latestLedger: res.latestLedger };
  }
}
