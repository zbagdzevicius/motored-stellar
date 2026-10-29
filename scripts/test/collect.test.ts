import { Address, Keypair, nativeToScVal, xdr } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import { cursorLedger, RpcEventSource } from '../metric/collect.js';

const TOKEN = 'CDDP3WONCQS5EWCTIITACO3FKIEY6BS5UB6ILE4MT3UGFO25CDYOY4VF';
const ESCROW = 'CBZKLCMGU4UK4N42GBUAJUZJNBBXF672U4MZURFPKGDQTRIVN5GJSX3X';
const buyer = Keypair.random().publicKey();

const cursorAt = (ledger: number) => `${(BigInt(ledger) << 32n).toString()}-4294967295`;

function transferEvent(ledger: number, amount: bigint, hash: string) {
  return {
    ledger,
    ledgerClosedAt: '2026-10-29T09:29:05Z',
    txHash: hash,
    topic: [xdr.ScVal.scvSymbol('transfer'), new Address(buyer).toScVal(), new Address(ESCROW).toScVal(), nativeToScVal('XEUR')],
    value: nativeToScVal(amount, { type: 'i128' }),
  };
}

describe('cursorLedger', () => {
  it('reads the ledger from the TOID part of an RPC event cursor', () => {
    expect(cursorLedger('0023401537334149119-4294967295')).toBe(5448594); // cursor returned by testnet RPC, 29 Oct 2026
    expect(cursorLedger(cursorAt(5441300))).toBe(5441300);
    expect(cursorLedger('not-a-cursor')).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('RpcEventSource paging', () => {
  it('keeps reading past a short page whose cursor is still behind the latest ledger', async () => {
    const latestLedger = 5448594;
    // Shape seen on testnet (run 7 metric): a short first page ending near ledger 5441300, the rest on the next.
    const pages = [
      { events: [transferEvent(5431331, 1_000_000_000n, 'a'.repeat(64))], cursor: cursorAt(5441300), latestLedger },
      { events: [transferEvent(5446746, 1_000_000_000n, 'b'.repeat(64))], cursor: cursorAt(latestLedger - 1), latestLedger },
      { events: [], cursor: cursorAt(latestLedger - 1), latestLedger },
    ];
    let calls = 0;
    const server = { getEvents: async () => pages[Math.min(calls++, pages.length - 1)] } as unknown as ConstructorParameters<typeof RpcEventSource>[0];
    const out = await new RpcEventSource(server, 1000).transfers(TOKEN, new Set([ESCROW]), 5431300);
    expect(out.map((t) => t.txHash)).toEqual(['a'.repeat(64), 'b'.repeat(64)]);
    expect(calls).toBe(3);
  });

  it('stops on a short page whose cursor has reached the latest ledger', async () => {
    const latestLedger = 100;
    let calls = 0;
    const server = {
      getEvents: async () => {
        calls++;
        return { events: [transferEvent(99, 5n, 'c'.repeat(64))], cursor: cursorAt(latestLedger), latestLedger };
      },
    } as unknown as ConstructorParameters<typeof RpcEventSource>[0];
    const out = await new RpcEventSource(server, 1000).transfers(TOKEN, new Set([ESCROW]), 1);
    expect(out).toHaveLength(1);
    expect(calls).toBe(1);
  });
});
