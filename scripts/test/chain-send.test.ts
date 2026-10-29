// Chain.send against a fake RPC server: the same retry, expiry and idempotency rules as
// RpcSubmitter in packages/escrow, including resending an evicted envelope.
import { Account, Keypair, Networks, Operation, TransactionBuilder, xdr, rpc, type Transaction } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import { TESTNET } from '../lib/network.js';
import { Chain, sendErrorCode, txMaxTime } from '../lib/soroban.js';

const source = Keypair.random();
const MAX_TIME = 1_800_000_000;

function unsignedTx(seq = '100'): Transaction {
  return new TransactionBuilder(new Account(source.publicKey(), seq), {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
    timebounds: { minTime: 0, maxTime: MAX_TIME },
  })
    .addOperation(Operation.bumpSequence({ bumpTo: '0' }))
    .build();
}

const txResult = (code: 'txBadSeq' | 'txInsufficientFee') =>
  new xdr.TransactionResult({ feeCharged: 0n, result: xdr.TransactionResultResult[code](), ext: xdr.TransactionResultExt.v0() });

type Get = { status: 'SUCCESS' | 'FAILED' | 'NOT_FOUND' };
const notFound = (n: number): Get[] => Array.from({ length: n }, () => ({ status: 'NOT_FOUND' }));

function fake(o: { sends: Array<{ status: string; errorResult?: xdr.TransactionResult }>; gets?: Get[]; accountSeq?: string }) {
  const log: string[] = [];
  const hashes: string[] = [];
  const printed: string[] = [];
  let clock = (MAX_TIME - 600) * 1000;
  let sends = 0;
  let gets = 0;
  const server = {
    sendTransaction: async (tx: Transaction) => {
      const hash = Buffer.from(tx.hash()).toString('hex');
      log.push('send');
      hashes.push(hash);
      return { hash, ...o.sends[Math.min(sends++, o.sends.length - 1)]! };
    },
    getTransaction: async () => {
      log.push('get');
      const r = (o.gets ?? [])[gets++] ?? { status: 'NOT_FOUND' };
      return {
        ...r,
        latestLedgerCloseTime: Math.floor(clock / 1000),
        ...(r.status === 'SUCCESS' ? { returnValue: xdr.ScVal.scvVoid() } : {}),
        ...(r.status === 'FAILED' ? { diagnosticEventsXdr: [] } : {}),
      };
    },
    getAccount: async () => new Account(source.publicKey(), o.accountSeq ?? '99'),
  } as unknown as rpc.Server;
  const chain = new Chain(TESTNET, (l) => printed.push(l), server, {
    pollMs: 5_000,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  });
  return { log, hashes, printed, chain };
}

describe('Chain.send', () => {
  it('logs the hash before sending and returns a known outcome without resending', async () => {
    const tx = unsignedTx();
    const f = fake({ sends: [{ status: 'PENDING' }], gets: [...notFound(1), { status: 'SUCCESS' }] });
    const r = await f.chain.send('t', tx, [source]);
    const hash = Buffer.from(tx.hash()).toString('hex');
    expect(r).toMatchObject({ hash, status: 'SUCCESS' });
    expect(f.printed[0]).toContain(`submitting ${hash}`);
    expect(f.log.slice(0, 2)).toEqual(['get', 'send']);
    expect(txMaxTime(tx)).toBe(MAX_TIME);

    const again = fake({ sends: [{ status: 'PENDING' }], gets: [{ status: 'SUCCESS' }] });
    expect((await again.chain.send('t', unsignedTx(), [source])).status).toBe('SUCCESS');
    expect(again.log).toEqual(['get']);
  });

  it('resends on TRY_AGAIN_LATER and while txBadSeq waits behind an earlier transaction', async () => {
    const f = fake({
      sends: [{ status: 'TRY_AGAIN_LATER' }, { status: 'ERROR', errorResult: txResult('txBadSeq') }, { status: 'PENDING' }],
      gets: [...notFound(3), { status: 'SUCCESS' }],
      accountSeq: '98',
    });
    expect((await f.chain.send('t', unsignedTx(), [source])).status).toBe('SUCCESS');
    expect(f.log.filter((l) => l === 'send')).toHaveLength(3);
  });

  it('reports txBadSeq with the sequence used up as retryable, other errors as final', async () => {
    const used = fake({ sends: [{ status: 'ERROR', errorResult: txResult('txBadSeq') }], accountSeq: '101' });
    expect(await used.chain.send('t', unsignedTx(), [source])).toMatchObject({ status: 'REJECTED', reason: 'txBadSeq', retryable: true });
    const fee = fake({ sends: [{ status: 'ERROR', errorResult: txResult('txInsufficientFee') }] });
    expect(await fee.chain.send('t', unsignedTx(), [source])).toMatchObject({ status: 'REJECTED', reason: 'txInsufficientFee', retryable: false });
    expect(sendErrorCode(undefined)).toBeUndefined();
  });

  it('resends the same envelope after a mempool eviction, and keeps polling if that resend errors', async () => {
    const f = fake({
      sends: [{ status: 'PENDING' }, { status: 'ERROR', errorResult: txResult('txBadSeq') }],
      gets: [...notFound(6), { status: 'SUCCESS' }],
      accountSeq: '101',
    });
    expect((await f.chain.send('t', unsignedTx(), [source])).status).toBe('SUCCESS');
    expect(f.hashes).toHaveLength(2);
    expect(new Set(f.hashes).size).toBe(1);
  });

  it('polls until a ledger closes past maxTime, then reports a safe-to-rebuild TIMEOUT', async () => {
    const f = fake({ sends: [{ status: 'PENDING' }] });
    const r = await f.chain.send('t', unsignedTx(), [source]);
    expect(r).toMatchObject({ status: 'TIMEOUT', reason: 'expired', retryable: true });
    expect(f.log.filter((l) => l === 'get').length).toBeGreaterThan(41);
    expect(f.chain.runLog.at(-1)).toMatchObject({ status: 'TIMEOUT', reason: 'expired', retryable: true });
  });
});
