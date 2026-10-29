// RpcSubmitter and RpcEventSource against a fake RPC server: retry, expiry and
// idempotency rules for submission, and getEvents request limits.

import { Account, Keypair, Networks, Operation, TransactionBuilder, xdr, type Transaction } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import { RpcEventSource, RpcSubmitter, sendErrorCode, symbolTopic, transactionHash, transactionMaxTime, type RpcSubmitterServer } from '../src/index.js';

const source = Keypair.random();
const MAX_TIME = 1_800_000_000;

function signedTx(seq = '100'): Transaction {
  const tx = new TransactionBuilder(new Account(source.publicKey(), seq), {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
    timebounds: { minTime: 0, maxTime: MAX_TIME },
  })
    .addOperation(Operation.bumpSequence({ bumpTo: '0' }))
    .build();
  tx.sign(source);
  return tx;
}

const txResult = (code: 'txBadSeq' | 'txInsufficientFee') =>
  new xdr.TransactionResult({ feeCharged: 0n, result: xdr.TransactionResultResult[code](), ext: xdr.TransactionResultExt.v0() });

/** A fake RPC: scripted sendTransaction replies, then getTransaction replies; a clock that moves on sleep. */
function fake(o: {
  sends: Array<{ status: string; errorResult?: xdr.TransactionResult }>;
  gets?: Array<{ status: 'SUCCESS' | 'FAILED' | 'NOT_FOUND'; latestLedgerCloseTime?: number }>;
  accountSeq?: string;
  startMs?: number;
}) {
  const log: string[] = [];
  let clock = o.startMs ?? (MAX_TIME - 600) * 1000;
  let sends = 0;
  let gets = 0;
  const hashes: string[] = [];
  const server = {
    sendTransaction: async (tx: Transaction) => {
      log.push('send');
      hashes.push(transactionHash(tx));
      const r = o.sends[Math.min(sends++, o.sends.length - 1)]!;
      return { hash: transactionHash(tx), ...r };
    },
    getTransaction: async () => {
      log.push('get');
      // The idempotency pre-check (and txBadSeq re-check) see NOT_FOUND unless scripted.
      const r = (o.gets ?? [])[gets++] ?? { status: 'NOT_FOUND' };
      return {
        status: r.status,
        latestLedgerCloseTime: r.latestLedgerCloseTime ?? Math.floor(clock / 1000),
        ...(r.status === 'SUCCESS' ? { returnValue: xdr.ScVal.scvVoid(), resultXdr: { feeCharged: 123n } } : {}),
      };
    },
    getAccount: async () => new Account(source.publicKey(), o.accountSeq ?? '99'),
  } as unknown as RpcSubmitterServer;
  const submitter = (hook?: (h: string) => void) =>
    new RpcSubmitter('https://rpc.invalid', {
      server,
      pollMs: 5_000,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      beforeSubmit: (h) => {
        log.push('beforeSubmit');
        hook?.(h);
      },
    });
  return { log, submitter, sentHashes: () => hashes };
}

describe('RpcSubmitter', () => {
  it('hands the hash to beforeSubmit before sending, and reads timebounds', async () => {
    const tx = signedTx();
    let saved: string | undefined;
    const f = fake({ sends: [{ status: 'PENDING' }], gets: [{ status: 'NOT_FOUND' }, { status: 'SUCCESS' }] });
    const r = await f.submitter((h) => (saved = h)).send(tx);
    expect(saved).toBe(transactionHash(tx));
    expect(f.log.slice(0, 3)).toEqual(['get', 'beforeSubmit', 'send']);
    expect(r).toMatchObject({ hash: saved, status: 'SUCCESS', feeCharged: 123n });
    expect(transactionMaxTime(tx)).toBe(MAX_TIME);
  });

  it('returns a recorded outcome without resending (idempotent retry)', async () => {
    const f = fake({ sends: [{ status: 'PENDING' }], gets: [{ status: 'SUCCESS' }] });
    const r = await f.submitter().send(signedTx());
    expect(r.status).toBe('SUCCESS');
    expect(f.log).toEqual(['get']);
  });

  it('resends on TRY_AGAIN_LATER instead of reporting REJECTED', async () => {
    const f = fake({
      sends: [{ status: 'TRY_AGAIN_LATER' }, { status: 'TRY_AGAIN_LATER' }, { status: 'PENDING' }],
      gets: [{ status: 'NOT_FOUND' }, { status: 'SUCCESS' }],
    });
    const r = await f.submitter().send(signedTx());
    expect(r.status).toBe('SUCCESS');
    expect(f.log.filter((l) => l === 'send')).toHaveLength(3);
  });

  it('waits out txBadSeq while an earlier transaction from the account is pending', async () => {
    // Account sequence 98 < 99: the tx (seq 101 after build) is still ahead of it.
    const f = fake({ sends: [{ status: 'ERROR', errorResult: txResult('txBadSeq') }, { status: 'PENDING' }], accountSeq: '98', gets: [{ status: 'NOT_FOUND' }, { status: 'NOT_FOUND' }, { status: 'SUCCESS' }] });
    const r = await f.submitter().send(signedTx());
    expect(r.status).toBe('SUCCESS');
  });

  it('reports txBadSeq as retryable once the sequence is used up', async () => {
    const f = fake({ sends: [{ status: 'ERROR', errorResult: txResult('txBadSeq') }], accountSeq: '101' });
    const r = await f.submitter().send(signedTx());
    expect(r).toMatchObject({ status: 'REJECTED', reason: 'txBadSeq', retryable: true });
  });

  it('reports other errors as final rejections', async () => {
    const f = fake({ sends: [{ status: 'ERROR', errorResult: txResult('txInsufficientFee') }] });
    expect(await f.submitter().send(signedTx())).toMatchObject({ status: 'REJECTED', reason: 'txInsufficientFee', retryable: false });
    expect(sendErrorCode(undefined)).toBeUndefined();
  });

  it('polls past 60 s until a ledger closes after maxTime, then reports a safe-to-rebuild TIMEOUT', async () => {
    const f = fake({ sends: [{ status: 'PENDING' }] }); // NOT_FOUND forever; the clock starts 600 s before maxTime
    const r = await f.submitter().send(signedTx());
    expect(r).toMatchObject({ status: 'TIMEOUT', reason: 'expired', retryable: true });
    expect(f.log.filter((l) => l === 'get').length).toBeGreaterThan(40 + 1); // the old limit was 40 polls (~60 s)
  });
  it('resends the same envelope when a PENDING transaction is evicted from the mempool', async () => {
    const tx = signedTx();
    // Pre-check NOT_FOUND, then 4 NOT_FOUND polls (eviction), resend, then SUCCESS.
    const gets = [...Array<{ status: 'NOT_FOUND' }>(5).fill({ status: 'NOT_FOUND' }), { status: 'SUCCESS' as const }];
    const f = fake({ sends: [{ status: 'PENDING' }], gets });
    const r = await f.submitter().send(tx);
    expect(r).toMatchObject({ status: 'SUCCESS', hash: transactionHash(tx) });
    expect(f.log.filter((l) => l === 'send')).toHaveLength(2);
    expect(f.log.filter((l) => l === 'beforeSubmit')).toHaveLength(1);
    expect(f.sentHashes()).toEqual([transactionHash(tx), transactionHash(tx)]);
  });

  it('keeps polling when a resend after PENDING errors (it may have applied): never a false REJECTED', async () => {
    // RPC has not ingested the ledger it applied in yet: one more NOT_FOUND after the resend.
    const gets = [...Array<{ status: 'NOT_FOUND' }>(6).fill({ status: 'NOT_FOUND' }), { status: 'SUCCESS' as const }];
    const f = fake({ sends: [{ status: 'PENDING' }, { status: 'ERROR', errorResult: txResult('txBadSeq') }], gets, accountSeq: '101' });
    const r = await f.submitter().send(signedTx());
    expect(r.status).toBe('SUCCESS');
  });

  it('resends an evicted transaction until maxTime, then reports expired', async () => {
    const f = fake({ sends: [{ status: 'PENDING' }] });
    const r = await f.submitter().send(signedTx());
    expect(r).toMatchObject({ status: 'TIMEOUT', reason: 'expired', retryable: true });
    expect(f.log.filter((l) => l === 'send').length).toBeGreaterThan(10);
  });
});

describe('RpcEventSource request shape', () => {
  function server() {
    const reqs: Array<{ filters: Array<{ contractIds: string[]; topics?: string[][] }>; startLedger?: number; cursor?: string }> = [];
    return {
      reqs,
      s: {
        getHealth: async () => ({ status: 'healthy', oldestLedger: 5_000, latestLedger: 6_000, ledgerRetentionWindow: 1_000 }),
        getEvents: async (req: (typeof reqs)[number]) => {
          reqs.push(req);
          return { events: [], cursor: 'c', latestLedger: 6_000, oldestLedger: 5_000 };
        },
      } as unknown as ConstructorParameters<typeof RpcEventSource>[0],
    };
  }
  const ids = (n: number) => Array.from({ length: n }, () => 'C' + 'A'.repeat(55));

  it('splits topic filters into groups of 5 and defaults the start ledger to the oldest retained one', async () => {
    const { reqs, s } = server();
    const topics = Array.from({ length: 9 }, (_, i) => [symbolTopic(`t${i}`)]);
    const page = await new RpcEventSource(s).getEvents({ contractIds: ids(5), topics });
    expect(reqs[0]!.filters.map((f) => f.topics!.length)).toEqual([5, 4]);
    expect(reqs[0]!.startLedger).toBe(5_000);
    expect(page.oldestLedger).toBe(5_000);
  });

  it('refuses more than 5 contract ids', async () => {
    const { reqs, s } = server();
    await expect(new RpcEventSource(s).getEvents({ contractIds: ids(6) })).rejects.toThrow(/at most 5/);
    expect(reqs).toHaveLength(0);
  });
});
