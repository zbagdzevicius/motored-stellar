/**
 * Gathers metric observations from chain data. Read-only: simulation and
 * getEvents only, so it may point at mainnet.
 *
 * Two ports:
 * - EscrowStateReader: each escrow's current `get_escrow` (roles, flags, amount, token).
 * - EventSource: token transfers into and out of the footprint escrows.
 *
 * RPC keeps a limited event history (SDF testnet RPC: `ledgerRetentionWindow` 120960
 * ledgers, about 7 days, read with getHealth on 29 Oct 2026, run 7; TODO(verify, D12):
 * the window of the mainnet RPC provider chosen for the live rollout), so a full 45-day
 * window is normally read from an indexer export instead: pass `--observations <file>` to the CLI, or plug an
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
 * Verified on testnet 29 Oct 2026 (@stellar/stellar-sdk 17.4): the run 4-5 escrows' transfers
 * decode with this shape (docs/verification.md, metric run; docs/runs/metric-observations-runs-4-5.json).
 */
export class RpcEventSource implements EventSource {
  constructor(private readonly server: Pick<rpc.Server, 'getEvents'> & Partial<Pick<rpc.Server, 'getHealth'>>, private readonly pageLimit = 1000) {}

  async transfers(token: string, accounts: Set<string>, startLedger: number): Promise<Transfer[]> {
    // One contract id (the token) per filter, within RPC's limit of 5. The start ledger must lie in
    // the RPC's retention window. It is not clamped: dropping the window's start would undercount
    // the metric, so a start before `oldestLedger` fails with a pointer to `--observations`.
    if (!Number.isInteger(startLedger) || startLedger < 1) throw new RangeError(`startLedger must be a ledger >= 1 (got ${startLedger})`);
    if (this.server.getHealth) {
      const h = await this.server.getHealth();
      if (startLedger < h.oldestLedger) {
        throw new RangeError(
          `startLedger ${startLedger} is older than this RPC's oldest ledger ${h.oldestLedger}: read the window from an archive export with --observations`,
        );
      }
    }
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
      // A short page does not mean the end: the RPC scans a bounded ledger range per request and
      // returns a cursor at the end of that range (seen on testnet 29 Oct 2026, run 7 metric: the
      // first page from ledger 5431300 held 23 events and stopped near ledger 5441300, the second
      // held the run 6 and run 7 transfers). Stop only when the cursor stops moving, or when the
      // page is short and the cursor has reached the RPC's latest ledger.
      if (!page.cursor || page.cursor === cursor) break;
      if (page.events.length < this.pageLimit && cursorLedger(page.cursor) >= page.latestLedger) break;
      cursor = page.cursor;
    }
    return out;
  }
}

/** Ledger sequence encoded in an RPC event cursor (`<toid>-<index>`, TOID ledger in the high 32 bits). */
export function cursorLedger(cursor: string): number {
  const toid = cursor.split('-')[0];
  if (!toid || !/^\d+$/.test(toid)) return Number.POSITIVE_INFINITY;
  return Number(BigInt(toid) >> 32n);
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
