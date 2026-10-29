// SPDX-License-Identifier: Apache-2.0
//
// Escrow event reader (SCF deliverable D1; consumed by reconciliation).
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
import type { EventSource, FundingHistory, FundRecord, RawContractEvent } from './ports.js';
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
      // TODO(verify): the map form `{ amount, to_muxed_id }` against a live muxed transfer.
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
 * TODO(verify): SAC transfer events carry 4 topics since Protocol 23 (asset last);
 * older events had 3. Add a 3-segment filter if reading pre-P23 history.
 */
export function transferOutFilter(escrowContractId: string): string[] {
  return [symbolTopic('transfer'), addressTopic(escrowContractId), '*', '*'];
}

/**
 * Polls Trustless Work events for registered escrows and token transfers out of
 * them. The caller persists `cursor` and the decoded events: RPC keeps events for
 * a limited window only.
 */
export class EscrowEventReader implements FundingHistory {
  constructor(
    private readonly source: EventSource,
    private readonly opts: {
      tokenContractId?: string;
      pageLimit?: number;
      /** First ledger `fundings()` scans from. Must lie inside the RPC's retention window. */
      fromLedger?: number;
    } = {},
  ) {}

  /** One page of Trustless Work events for `escrows`, decoded. */
  async poll(escrows: string[], from: { cursor?: string; startLedger?: number } = {}): Promise<{ events: DecodedEvent[]; cursor?: string }> {
    const page = await this.source.getEvents({
      contractIds: escrows,
      topics: twTopicFilters(),
      cursor: from.cursor,
      startLedger: from.startLedger,
      limit: this.opts.pageLimit ?? 100,
    });
    return { events: page.events.filter((e) => e.inSuccessfulContractCall !== false).map(decodeEvent), cursor: page.cursor };
  }

  /** Token transfers out of `escrow` (releases, resolutions and withdrawals). */
  async transfersOut(escrow: string, from: { cursor?: string; startLedger?: number } = {}): Promise<{ events: DecodedEvent[]; cursor?: string }> {
    if (!this.opts.tokenContractId) throw new Error('tokenContractId not configured');
    const page = await this.source.getEvents({
      contractIds: [this.opts.tokenContractId],
      topics: [transferOutFilter(escrow)],
      cursor: from.cursor,
      startLedger: from.startLedger,
      limit: this.opts.pageLimit ?? 100,
    });
    return { events: page.events.map(decodeEvent), cursor: page.cursor };
  }

  /** Every `fund_escrow` call on `escrow` (pages until exhausted). */
  async fundings(escrow: string): Promise<FundRecord[]> {
    const out: FundRecord[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await this.source.getEvents({
        contractIds: [escrow],
        topics: [[symbolTopic('tw_fund')]],
        cursor,
        startLedger: cursor ? undefined : (this.opts.fromLedger ?? 0),
        limit: this.opts.pageLimit ?? 100,
      });
      for (const raw of page.events) {
        const d = decodeEvent(raw);
        if (d.kind === 'tw_fund') out.push({ signer: d.signer, amount: d.amount, txHash: d.txHash, ledger: d.ledger });
      }
      if (page.events.length === 0 || page.cursor === cursor) break;
      cursor = page.cursor;
    }
    return out;
  }
}
