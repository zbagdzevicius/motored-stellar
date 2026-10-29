/**
 * Gathers metric observations from chain data. Read-only: simulation and
 * getEvents only, so it may point at mainnet.
 *
 * Two ports:
 * - EscrowStateReader: each escrow's current `get_escrow` (roles, flags, amount, token).
 * - EventSource: token transfers into and out of the footprint escrows.
 *
 * RPC keeps a limited event history (TODO(verify): the retention window of the
 * chosen RPC provider), so a full 45-day window is normally read from an
 * indexer export instead: pass `--observations <file>` to the CLI, or plug an
 * indexer-backed EventSource here.
 */
import { Address, scValToNative, xdr, type rpc } from '@stellar/stellar-sdk';
import type { Chain } from '../lib/soroban.js';
import type { EscrowObservation, Footprint, Transfer } from './metric.js';

export interface EscrowState {
  amount: bigint;
  token: string;
  roles: EscrowObservation['roles'];
  flags: EscrowObservation['flags'];
  buyerApproved: boolean;
}

export interface EscrowStateReader {
  escrow(id: string): Promise<EscrowState | undefined>;
}

export interface EventSource {
  /** Transfers of `token` where `from` or `to` is one of `accounts`. */
  transfers(token: string, accounts: Set<string>, startLedger: number): Promise<Transfer[]>;
}

/** Decoded `get_escrow` (Trustless Work v1 single-release Escrow struct). */
interface RawEscrow {
  amount: bigint;
  roles: Record<string, string>;
  flags: { released: boolean; resolved: boolean; disputed: boolean };
  milestones: Array<{ approved: boolean }>;
  trustline: { address: string };
}

export class RpcEscrowStateReader implements EscrowStateReader {
  constructor(private readonly chain: Chain, private readonly source: string) {}

  async escrow(id: string): Promise<EscrowState | undefined> {
    const r = await this.chain.read(id, 'get_escrow', [], this.source);
    if ('error' in r) return undefined;
    const e = scValToNative(r.val) as RawEscrow;
    const role = (k: string) => String(e.roles[k] ?? '');
    return {
      amount: BigInt(e.amount),
      token: e.trustline.address,
      roles: {
        approver: role('approver'),
        receiver: role('receiver'),
        service_provider: role('service_provider'),
        platform: role('platform'),
        release_signer: role('release_signer'),
        dispute_resolver: role('dispute_resolver'),
      },
      flags: { released: e.flags.released, resolved: e.flags.resolved, disputed: e.flags.disputed },
      // Only the buyer (approver) can approve; all approved means not a silent-buyer resolution.
      buyerApproved: e.milestones.length > 0 && e.milestones.every((m) => m.approved),
    };
  }
}

/**
 * Stellar Asset Contract transfer events via RPC getEvents.
 * Topics: ["transfer", from, to, asset]; data: i128, or a map with `amount`
 * when a muxed id is attached (CAP-67).
 * TODO(verify): topic count and data shape on the target protocol version.
 */
export class RpcEventSource implements EventSource {
  constructor(private readonly server: Pick<rpc.Server, 'getEvents'>, private readonly pageLimit = 1000) {}

  async transfers(token: string, accounts: Set<string>, startLedger: number): Promise<Transfer[]> {
    const transferTopic = xdr.ScVal.scvSymbol('transfer').toXDR('base64');
    const out: Transfer[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await this.server.getEvents(
        cursor
          ? { cursor, filters: [{ type: 'contract', contractIds: [token], topics: [[transferTopic, '*', '*', '*']] }], limit: this.pageLimit }
          : { startLedger, filters: [{ type: 'contract', contractIds: [token], topics: [[transferTopic, '*', '*', '*']] }], limit: this.pageLimit },
      );
      for (const ev of page.events) {
        const t = decodeTransfer(ev.topic, ev.value, ev.ledgerClosedAt, ev.txHash);
        if (t && (accounts.has(t.from) || accounts.has(t.to))) out.push(t);
      }
      if (page.events.length < this.pageLimit || !page.cursor) break;
      cursor = page.cursor;
    }
    return out;
  }
}

/** Decodes one SAC transfer event, or returns undefined for anything else. */
export function decodeTransfer(topic: xdr.ScVal[], value: xdr.ScVal, closedAt: string, txHash: string): Transfer | undefined {
  if (topic.length < 3) return undefined;
  if (scValToNative(topic[0] as xdr.ScVal) !== 'transfer') return undefined;
  const from = Address.fromScVal(topic[1] as xdr.ScVal).toString();
  const to = Address.fromScVal(topic[2] as xdr.ScVal).toString();
  const v = scValToNative(value) as bigint | { amount?: bigint };
  const amount = typeof v === 'bigint' ? v : typeof v === 'object' && v && v.amount !== undefined ? BigInt(v.amount) : undefined;
  if (amount === undefined) return undefined;
  return { from, to, amount, at: Math.floor(Date.parse(closedAt) / 1000), txHash };
}

/** Builds observations for every footprint escrow (excluded ones too, so they can be listed). */
export async function collectObservations(fp: Footprint, states: EscrowStateReader, events: EventSource, startLedger: number): Promise<EscrowObservation[]> {
  const ids = new Set([...fp.escrows, ...(fp.excluded ?? [])]);
  const transfers = await events.transfers(fp.token, ids, startLedger);
  const out: EscrowObservation[] = [];
  for (const id of ids) {
    const s = await states.escrow(id);
    if (!s) continue;
    out.push({ id, ...s, transfers: transfers.filter((t) => t.from === id || t.to === id) });
  }
  return out;
}
