// Event decoder against real testnet events (public data, committed under fixtures/):
//  - testnet-lifecycle-events.json: two lab escrows (24 Oct 2026) going through
//    init, fund, approve, dispute, release, resolution and update;
//  - testnet-fund-events.json: three small fund_escrow calls on one escrow (18 Oct 2026).

import { readFileSync } from 'node:fs';
import { Address, Keypair, nativeToScVal, xdr } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import {
  addr,
  assessFunding,
  chunkContractIds,
  cursorLedger,
  decodeEvent,
  EscrowEventReader,
  InMemoryEventSource,
  ledgerEndCursor,
  str,
  struct,
  sym,
  symbolTopic,
  topicMatches,
  transferOutFilter,
  type RawContractEvent,
} from '../src/index.js';

const load = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as { result: { events: RawContractEvent[] } };
const lifecycle = load('testnet-lifecycle-events.json');
const funds = load('testnet-fund-events.json');

const ESCROW_A = 'CC3FOQA55L7ZJI6L3IDCSARERTLGJMWTEFQCQX7MTUUODTLESA3T2ZTK';
const ESCROW_B = 'CCPOJY5UG2ELCMP5FYG5GSOWMW6QJ47XUVPMEFGQOC4BDF7CAOSMK5KQ';
const GUARD = 'CDJ5BNPZII6XPW4UCYYEF4LPOTJY7ZHPY3P6BVRYWZLED2RTFDJVGJ3F';
const BUYER = 'GDH7BQS6VRZ2RJ6BA7YU23LMM4LC7UDALWHMKVEJT5VWMC4I6CQWPJGI';
const SELLER = 'GAGWNO3ASYMQKFC5PR4QCPT6B6LZU72MBRTYI7ENODAXV77AHO5SRIJZ';
const PLATFORM = 'GA4PAESM5E4LUJLC4VECTXW5DY4DUFA56IU7QDVKVRWQHWUNKFHXMBWC';
const TOKEN = 'CCBFC27MDMJW3N2RPGXWOIDIAN57IE5E4QFY7HCQSSPOBVOOCGOL563R';

describe('decodeEvent on testnet fixtures', () => {
  const decoded = lifecycle.result.events.map(decodeEvent);

  it('recognises every Trustless Work topic in order', () => {
    expect(decoded.map((d) => d.kind)).toEqual([
      'tw_init',
      'tw_init',
      'tw_fund',
      'tw_fund',
      'tw_ms_approve',
      'tw_dispute',
      'tw_release',
      'tw_disp_resolve',
      'tw_dispute',
      'tw_update',
    ]);
  });

  it('decodes tw_init into the full escrow with the guard in both roles', () => {
    const d = decoded[0]!;
    if (d.kind !== 'tw_init') throw new Error('expected tw_init');
    expect(d.contractId).toBe(ESCROW_A);
    expect(d.txHash).toBe('1e692b64269d95fdc277be8583f4c8125a225a02d979bffb46d25a4eae53dfee');
    expect(d.escrow).toEqual({
      engagementId: 'lab-order-1',
      title: 'lab',
      description: 'lab',
      roles: { approver: BUYER, serviceProvider: SELLER, platform: PLATFORM, releaseSigner: GUARD, disputeResolver: GUARD, receiver: SELLER },
      amount: 100_000_000n,
      platformFeeBps: 400,
      milestones: [{ description: 'Deliver part', status: 'awaiting delivery', evidence: '', approved: false }],
      flags: { disputed: false, released: false, resolved: false },
      trustline: TOKEN,
      receiverMemo: 0,
    });
  });

  it('decodes tw_fund as (signer, amount)', () => {
    const d = decoded[2]!;
    expect(d).toMatchObject({ kind: 'tw_fund', contractId: ESCROW_A, signer: BUYER, amount: 100_000_000n, ledger: 5369620 });
  });

  it('decodes approval, dispute, release and resolution states', () => {
    const approve = decoded[4]!;
    if (approve.kind !== 'tw_ms_approve') throw new Error('expected tw_ms_approve');
    expect(approve.escrow.milestones[0]!.approved).toBe(true);

    const dispute = decoded[5]!;
    if (dispute.kind !== 'tw_dispute') throw new Error('expected tw_dispute');
    expect(dispute.contractId).toBe(ESCROW_B);
    expect(dispute.escrow.flags).toEqual({ disputed: true, released: false, resolved: false });

    expect(decoded[6]).toMatchObject({ kind: 'tw_release', contractId: ESCROW_A, releaseSigner: GUARD });

    const resolved = decoded[7]!;
    if (resolved.kind !== 'tw_disp_resolve') throw new Error('expected tw_disp_resolve');
    expect(resolved.escrow.flags).toEqual({ disputed: false, released: false, resolved: true });
  });

  it('decodes tw_update as (platform, engagement id, new escrow)', () => {
    const d = decoded[9]!;
    if (d.kind !== 'tw_update') throw new Error('expected tw_update');
    expect(d.platform).toBe(PLATFORM);
    expect(d.engagementId).toBe('lab-order-2');
    expect(d.escrow.roles.approver).toBe('GCWGFZEZPF6BNXLQETUEMDTY3C2XUFNPPY4MXQS6TGAM4KR5PVGY7NFW');
  });

  it('decodes a SAC transfer out of an escrow (plain i128 and CAP-67 map data)', () => {
    const to = Keypair.random().publicKey();
    const base = { id: '1', ledger: 1, ledgerClosedAt: '', contractId: TOKEN, txHash: '00' };
    const topic = [sym('transfer'), addr(ESCROW_A), addr(to), str(`EURC:${PLATFORM}`)].map((t) => t.toXDR('base64'));
    const plain = decodeEvent({ ...base, topic, value: nativeToScVal(950n, { type: 'i128' }).toXDR('base64') });
    expect(plain).toMatchObject({ kind: 'token_transfer', from: ESCROW_A, to, amount: 950n, asset: `EURC:${PLATFORM}` });
    const muxed = decodeEvent({
      ...base,
      topic,
      value: struct({ amount: nativeToScVal(7n, { type: 'i128' }), to_muxed_id: xdr.ScVal.scvU64(xdr.Uint64.fromString('5')) }).toXDR('base64'),
    });
    expect(muxed).toMatchObject({ kind: 'token_transfer', amount: 7n });
    expect(topicMatches({ ...base, topic, value: '' }, transferOutFilter(ESCROW_A))).toBe(true);
    expect(topicMatches({ ...base, topic, value: '' }, transferOutFilter(ESCROW_B))).toBe(false);
  });

  it('keeps unknown events instead of throwing', () => {
    const d = decodeEvent({ id: '1', ledger: 1, ledgerClosedAt: '', contractId: ESCROW_A, txHash: '00', topic: [symbolTopic('other')], value: sym('x').toXDR('base64') });
    expect(d.kind).toBe('unknown');
  });
});

describe('EscrowEventReader over a fixture-backed source', () => {
  it('pages Trustless Work events per escrow with a cursor', async () => {
    const reader = new EscrowEventReader(InMemoryEventSource.fromRpcResponse(lifecycle), { pageLimit: 2 });
    const kinds: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i++) {
      const page = await reader.poll([ESCROW_A], cursor ? { cursor } : { startLedger: 0 });
      if (page.events.length === 0) break;
      kinds.push(...page.events.map((e) => e.kind));
      cursor = page.cursor;
    }
    expect(kinds).toEqual(['tw_init', 'tw_fund', 'tw_ms_approve', 'tw_release', 'tw_dispute']);
  });

  it('builds the funding history and the paid decision from tw_fund events', async () => {
    const reader = new EscrowEventReader(InMemoryEventSource.fromRpcResponse(lifecycle));
    const f = await reader.fundings(ESCROW_B);
    expect(f).toEqual([{ signer: BUYER, amount: 100_000_000n, txHash: '19c861a9f244f3d251613734daa5027fd214758351ba8c76c68a2ddd86a475c2', ledger: 5369621 }]);
    expect(assessFunding({ amount: 100_000_000n, balance: 100_000_000n }, BUYER, f).paid).toBe(true);
    expect(assessFunding({ amount: 100_000_000n, balance: 100_000_000n }, SELLER, f)).toMatchObject({ paid: false, flags: ['PARTIAL', 'THIRD_PARTY_FUNDING'] });
  });

  it('sums repeated fund_escrow calls from one signer', async () => {
    const reader = new EscrowEventReader(InMemoryEventSource.fromRpcResponse(funds), { pageLimit: 1 });
    const f = await reader.fundings('CBKKVPHHQIKR76RVFNNXXV73HZLON7IOS7IOKMNG4ZXZJHPNGHFC2F3W');
    expect(f.map((x) => x.amount)).toEqual([2999n, 2999n, 2999n]);
    const signer = 'GAJNTKOPP733TXDRBLPAVKA6TS3KQMR2HNXAEPLCL3WSXIW6EFDQOL5U';
    const a = assessFunding({ amount: 8997n, balance: 8997n }, signer, f);
    expect(a).toMatchObject({ paid: true, buyerFunded: 8997n, excess: 0n, flags: [] });
  });
});

describe('EscrowEventReader within Stellar RPC getEvents limits', () => {
  // Synthetic tw_fund events in RPC's id format (TOID of the ledger, then the event index).
  const eventId = (ledger: number, n: number) => `${((BigInt(ledger) << 32n) | BigInt(n)).toString().padStart(19, '0')}-0000000000`;
  const escrows = Array.from({ length: 7 }, () => Address.contract(Keypair.random().rawPublicKey()).toString());
  const fundEvent = (contractId: string, ledger: number, n: number, amount: bigint): RawContractEvent => ({
    id: eventId(ledger, n),
    ledger,
    ledgerClosedAt: '2026-10-29T00:00:00Z',
    contractId,
    txHash: n.toString(16).padStart(64, '0'),
    topic: [symbolTopic('tw_fund')],
    value: xdr.ScVal.scvVec([addr(BUYER), nativeToScVal(amount, { type: 'i128' })]).toXDR('base64'),
  });
  // Escrow i is funded at ledger 10,000 + 1,000 i; the last one again near the latest ledger.
  const events = [...escrows.map((e, i) => fundEvent(e, 10_000 + 1_000 * i, i + 1, BigInt(i + 1))), fundEvent(escrows[6]!, 19_990, 99, 50n)];

  it('reads more than 5 escrows in groups of 5, from the oldest retained ledger, past empty pages', async () => {
    const source = new InMemoryEventSource(events, { oldestLedger: 9_000, latestLedger: 20_000, scanLedgers: 2_000 });
    const reader = new EscrowEventReader(source, { pageLimit: 10 });
    const r = await reader.readAll(escrows);
    expect(r.events.map((e) => e.contractId)).toEqual([...escrows, escrows[6]]);
    expect(r.latestLedger).toBe(20_000);
    expect(source.queries.every((q) => q.contractIds.length <= 5)).toBe(true);
    expect(new Set(source.queries.map((q) => q.contractIds.length))).toEqual(new Set([5, 2]));
    // The start ledger is clamped to the oldest retained ledger, never 0.
    expect(source.queries.filter((q) => !q.cursor).map((q) => q.startLedger)).toEqual([9_000, 9_000]);
    // The second group (escrows 5 and 6) sees nothing for its first scans and keeps paging.
    expect(source.queries.some((q) => q.contractIds.length === 2 && q.cursor !== undefined)).toBe(true);
  });

  it('refuses a single page for more than 5 escrows (the RPC would reject it)', async () => {
    const reader = new EscrowEventReader(new InMemoryEventSource(events));
    await expect(reader.poll(escrows)).rejects.toThrow(RangeError);
    await expect(new InMemoryEventSource(events).getEvents({ contractIds: escrows })).rejects.toThrow(/at most 5/);
  });

  it('keeps the full funding history when a scan range in the middle is empty', async () => {
    // The old reader stopped at the first empty page and missed the second funding.
    const source = new InMemoryEventSource(events, { oldestLedger: 9_000, latestLedger: 20_000, scanLedgers: 2_000 });
    const f = await new EscrowEventReader(source, { fromLedger: 1 }).fundings(escrows[6]!);
    expect(f.map((x) => [x.ledger, x.amount])).toEqual([
      [16_000, 7n],
      [19_990, 50n],
    ]);
    expect(source.queries[0]!.startLedger).toBe(9_000); // fromLedger 1 clamped to oldestLedger
    expect(source.queries.length).toBeGreaterThan(2);
  });

  it('round-trips a ledger-end cursor', () => {
    expect(cursorLedger(ledgerEndCursor(5_448_594))).toBe(5_448_594);
    expect(ledgerEndCursor(5_448_594)).toBe('0023401537334149119-4294967295'); // cursor returned by testnet RPC, 29 Oct 2026
    expect(chunkContractIds(escrows).map((c) => c.length)).toEqual([5, 2]);
  });
});
