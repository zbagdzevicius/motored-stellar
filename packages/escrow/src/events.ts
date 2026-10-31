// SPDX-License-Identifier: Apache-2.0
//
// Escrow event reader (pre-award; used by SCF deliverable D1; consumed by reconciliation).
//
// Trustless Work v1 emits one event per state change, topic = [symbol], with
// these data shapes (from the contract's `events/handler.rs`, confirmed against
// testnet events committed under test/fixtures):
//
//   tw_init          vec[Escrow]
//   tw_fund          vec[signer: Address, amount: i128]
//   tw_release       release_signer: Address           (single value)
//   tw_update        vec[platform: Address, engagement_id: String, Escrow]
//   tw_ms_change     vec[Escrow]
//   tw_ms_approve    vec[Escrow]
//   tw_dispute       vec[Escrow]
//   tw_disp_resolve  vec[Escrow]                        (no amounts)
//   tw_ttl_extend    (kept raw)
//
// `withdraw_remaining_funds` emits no Trustless Work event, and resolutions carry
// no amounts, so money leaving an escrow is read from the token's (SAC) `transfer`
// events where `from` is the escrow.

import { scValToNative, xdr } from '@stellar/stellar-sdk';
import { escrowFromNative, type OnChainEscrow } from './escrow-types.js';
import { cursorLedger, RPC_MAX_CONTRACT_IDS, type EventQuery, type EventSource, type FundingHistory, type FundRecord, type RawContractEvent } from './ports.js';
import { addressTopic, symbolTopic } from './scval.js';

export const TW_EVENT_TOPICS = [
  'tw_init',
  'tw_fund',
  'tw_release',
  'tw_update',
  'tw_ms_change',
  'tw_ms_approve',
  'tw_dispute',
  'tw_disp_resolve',
  'tw_ttl_extend',
] as const;
export type TwEventTopic = (typeof TW_EVENT_TOPICS)[number];

export interface EventMeta {
  id: string;
  ledger: number;
  ledgerClosedAt: string;
  contractId: string;
  txHash: string;
}

export type DecodedEvent = EventMeta &
  (
    | { kind: 'tw_init'; escrow: OnChainEscrow }
    | { kind: 'tw_fund'; signer: string; amount: bigint }
    | { kind: 'tw_release'; releaseSigner: string }
    | { kind: 'tw_update'; platform: string; engagementId: string; escrow: OnChainEscrow }
    | { kind: 'tw_ms_change' | 'tw_ms_approve' | 'tw_dispute' | 'tw_disp_resolve'; escrow: OnChainEscrow }
    | { kind: 'tw_ttl_extend'; data: unknown }
    | { kind: 'token_transfer'; from: string; to: string; amount: bigint; asset?: string }
    | { kind: 'unknown'; topics: unknown[]; data: unknown }
  );

const native = (b64: string): unknown => scValToNative(xdr.ScVal.fromXDR(b64, 'base64'));

function onlyEscrow(data: unknown, topic: string): OnChainEscrow {
  if (!Array.isArray(data) || data.length !== 1) throw new TypeError(`${topic}: expected vec[Escrow]`);
  return escrowFromNative(data[0]);
}

function toBigint(v: unknown, what: string): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isInteger(v)) return BigInt(v);
  throw new TypeError(`${what}: expected an integer`);
}

/** Decodes one raw contract event (Trustless Work or SAC transfer). */
export function decodeEvent(raw: RawContractEvent): DecodedEvent {
  const meta: EventMeta = { id: raw.id, ledger: raw.ledger, ledgerClosedAt: raw.ledgerClosedAt, contractId: raw.contractId, txHash: raw.txHash };
  const topics = raw.topic.map(native);
  const data = native(raw.value);
  const t0 = topics[0];

  switch (t0) {
    case 'tw_init':
      return { ...meta, kind: 'tw_init', escrow: onlyEscrow(data, 'tw_init') };
    case 'tw_fund': {
      if (!Array.isArray(data) || data.length !== 2 || typeof data[0] !== 'string') throw new TypeError('tw_fund: expected vec[Address, i128]');
      return { ...meta, kind: 'tw_fund', signer: data[0], amount: toBigint(data[1], 'tw_fund.amount') };
    }
    case 'tw_release':
      if (typeof data !== 'string') throw new TypeError('tw_release: expected an address');
      return { ...meta, kind: 'tw_release', releaseSigner: data };
    case 'tw_update': {
      if (!Array.isArray(data) || data.length !== 3 || typeof data[0] !== 'string' || typeof data[1] !== 'string') {
        throw new TypeError('tw_update: expected vec[Address, String, Escrow]');
      }
      return { ...meta, kind: 'tw_update', platform: data[0], engagementId: data[1], escrow: escrowFromNative(data[2]) };
    }
    case 'tw_ms_change':
    case 'tw_ms_approve':
    case 'tw_dispute':
    case 'tw_disp_resolve':
      return { ...meta, kind: t0 as 'tw_ms_change' | 'tw_ms_approve' | 'tw_dispute' | 'tw_disp_resolve', escrow: onlyEscrow(data, t0 as string) };
    case 'tw_ttl_extend':
      return { ...meta, kind: 'tw_ttl_extend', data };
    case 'transfer': {
      // SAC transfer: topics [transfer, from, to, asset?]; data is the i128 amount,
      // or (CAP-67, muxed destinations) a map with `amount`.
      // TODO(verify, D5): the map form `{ amount, to_muxed_id }` against a live muxed transfer
      // (no run so far sent to a muxed address; the Bridge sandbox run in D5 is the first that may).
      const from = topics[1];
      const to = topics[2];
      if (typeof from !== 'string' || typeof to !== 'string') break;
      const amount =
        data !== null && typeof data === 'object' && !Array.isArray(data) && 'amount' in (data as object)
          ? toBigint((data as { amount: unknown }).amount, 'transfer.amount')
          : toBigint(data, 'transfer.amount');
      return { ...meta, kind: 'token_transfer', from, to, amount, asset: typeof topics[3] === 'string' ? topics[3] : undefined };
    }
    default:
      break;
  }
  return { ...meta, kind: 'unknown', topics, data };
}

/** RPC topic filter for all Trustless Work events. */
export function twTopicFilters(topics: readonly TwEventTopic[] = TW_EVENT_TOPICS): string[][] {
  return topics.map((t) => [symbolTopic(t)]);
}

/**
 * RPC topic filter for token transfers out of `escrow`: [transfer, from=escrow, *, *].
 * SAC transfer events carry 4 topics since Protocol 23 (asset last). Verified on testnet in
 * runs 4 to 7: every escrow transfer matched a 4-segment filter (docs/runs/metric-observations-runs-4-6.json,
 * metric-observations-run-7.json). Older events had 3: add a 3-segment filter for pre-P23 history.
 */
export function transferOutFilter(escrowContractId: string): string[] {
  return [symbolTopic('transfer'), addressTopic(escrowContractId), '*', '*'];
}

/** Splits `ids` into groups RPC accepts in one `contractIds` filter. */
export function chunkContractIds(ids: readonly string[], size = RPC_MAX_CONTRACT_IDS): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

/**
 * Polls Trustless Work events for registered escrows and token transfers out of
 * them. The caller persists `cursor` and the decoded events: RPC keeps events for
 * a limited window only.
 *
 * RPC limits honoured here: at most 5 contract ids per filter (`readAll` and
 * `fundings` split larger sets), a start ledger inside the retention window
 * (clamped to `oldestLedger`, never 0), and a bounded scan per request (paging
 * continues until the cursor reaches `latestLedger`, not until the first empty page).
 */
export class EscrowEventReader implements FundingHistory {
  constructor(
    private readonly source: EventSource,
    private readonly opts: {
      tokenContractId?: string;
      pageLimit?: number;
      /** First ledger `fundings()` scans from. Clamped to the source's oldest retained ledger. */
      fromLedger?: number;
    } = {},
  ) {}

  /** `requested` clamped into the source's retention window; never below ledger 1. */
  private async startLedger(requested?: number): Promise<number> {
    const range = this.source.ledgerRange ? await this.source.ledgerRange() : undefined;
    let s = requested ?? range?.oldestLedger ?? 1;
    if (range) s = Math.min(Math.max(s, range.oldestLedger), range.latestLedger);
    return Math.max(s, 1);
  }

  /** Every event matching `q` from `startLedger` to the source's latest ledger. `q.contractIds` must fit one filter. */
  private async scan(q: Omit<EventQuery, 'cursor' | 'startLedger' | 'limit'>, startLedger: number): Promise<{ events: RawContractEvent[]; latestLedger?: number }> {
    const limit = this.opts.pageLimit ?? 100;
    const events: RawContractEvent[] = [];
    let cursor: string | undefined;
    let latestLedger: number | undefined;
    for (;;) {
      const page = await this.source.getEvents({ ...q, cursor, startLedger: cursor ? undefined : startLedger, limit });
      events.push(...page.events);
      latestLedger = page.latestLedger ?? latestLedger;
      // An empty or short page is not the end: RPC scans a bounded ledger range per request
      // and returns a cursor at the end of that range. Stop when the cursor stops moving, or
      // when the page is short and the cursor has reached the latest ledger (a source that
      // reports no latest ledger ends on its first short page).
      if (!page.cursor || page.cursor === cursor) break;
      if (page.events.length < limit && (page.latestLedger === undefined || cursorLedger(page.cursor) >= page.latestLedger)) break;
      cursor = page.cursor;
    }
    return { events, latestLedger };
  }

  /** One page of Trustless Work events for up to 5 `escrows`, decoded. Use `readAll` for more. */
  async poll(escrows: string[], from: { cursor?: string; startLedger?: number } = {}): Promise<{ events: DecodedEvent[]; cursor?: string }> {
    if (escrows.length > RPC_MAX_CONTRACT_IDS) throw new RangeError(`poll takes at most ${RPC_MAX_CONTRACT_IDS} escrows (RPC limit); use readAll`);
    const page = await this.source.getEvents({
      contractIds: escrows,
      topics: twTopicFilters(),
      cursor: from.cursor,
      startLedger: from.cursor ? undefined : await this.startLedger(from.startLedger),
      limit: this.opts.pageLimit ?? 100,
    });
    return { events: page.events.filter((e) => e.inSuccessfulContractCall !== false).map(decodeEvent), cursor: page.cursor };
  }

  /**
   * Every Trustless Work event for `escrows` (any number) from `startLedger` to the
   * source's latest ledger, in event order. Escrows are read in groups of 5. Resume
   * with `startLedger: latestLedger` and drop events whose id you already hold.
   */
  async readAll(escrows: string[], from: { startLedger?: number } = {}): Promise<{ events: DecodedEvent[]; latestLedger?: number }> {
    const start = await this.startLedger(from.startLedger);
    const byId = new Map<string, RawContractEvent>();
    let latestLedger: number | undefined;
    for (const ids of chunkContractIds(escrows)) {
      const r = await this.scan({ contractIds: ids, topics: twTopicFilters() }, start);
      for (const e of r.events) if (e.inSuccessfulContractCall !== false) byId.set(e.id, e);
      if (r.latestLedger !== undefined) latestLedger = Math.max(latestLedger ?? 0, r.latestLedger);
    }
    const events = [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map(decodeEvent);
    return { events, latestLedger };
  }

  /** Token transfers out of `escrow` (releases, resolutions and withdrawals). */
  async transfersOut(escrow: string, from: { cursor?: string; startLedger?: number } = {}): Promise<{ events: DecodedEvent[]; cursor?: string }> {
    if (!this.opts.tokenContractId) throw new Error('tokenContractId not configured');
    const page = await this.source.getEvents({
      contractIds: [this.opts.tokenContractId],
      topics: [transferOutFilter(escrow)],
      cursor: from.cursor,
      startLedger: from.cursor ? undefined : await this.startLedger(from.startLedger),
      limit: this.opts.pageLimit ?? 100,
    });
    return { events: page.events.map(decodeEvent), cursor: page.cursor };
  }

  /** Every `fund_escrow` call on `escrow`, from `fromLedger` (clamped) to the latest ledger. */
  async fundings(escrow: string): Promise<FundRecord[]> {
    const { events } = await this.scan({ contractIds: [escrow], topics: [[symbolTopic('tw_fund')]] }, await this.startLedger(this.opts.fromLedger));
    const out: FundRecord[] = [];
    for (const raw of events) {
      if (raw.inSuccessfulContractCall === false) continue;
      const d = decodeEvent(raw);
      if (d.kind === 'tw_fund') out.push({ signer: d.signer, amount: d.amount, txHash: d.txHash, ledger: d.ledger });
    }
    return out;
  }
}
