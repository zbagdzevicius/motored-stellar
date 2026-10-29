/**
 * `ChainReader` over Soroban RPC.
 *
 * Reads escrow state and SAC balances straight from ledger entries, EURC
 * transfers from SAC `transfer` events, transaction outcomes from
 * `getTransaction`, trustlines from ledger entries and the retention window
 * from `getHealth`.
 *
 * Limitation, by design visible: RPC keeps events for a limited window only
 * (about 7 days on the public testnet RPC; the public fixture
 * `test/fixtures/rpc-getevents-empty.json` shows a 120,959-ledger window). A
 * reader that must see an escrow's whole history beyond that needs an indexer
 * behind the same `ChainReader` interface. This reader reports the unreadable
 * range as a gap, so the reconciliation fails instead of passing on partial
 * data.
 */
import { Address, Asset, Keypair, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import type {
  ChainReader,
  EscrowChainState,
  EurcBalance,
  EurcTransfer,
  EventCoverage,
  TrustlineState,
  TxStatus,
} from "../ports.js";

/** Classic trustline flag: authorised to hold and send. */
const AUTHORIZED_FLAG = 1;

export interface RpcChainReaderOptions {
  rpcUrl: string;
  /** EURC SAC contract ID (C...). */
  eurcSac: string;
  /** EURC classic asset, for trustline reads. */
  eurc: { code: string; issuer: string };
  /**
   * First ledger the caller needs transfers from (for example the ledger the
   * first registered escrow was created in). Ranges older than the RPC's
   * retention are reported as gaps by `getEventCoverage`.
   */
  startLedger: number;
  /** Page size for `getEvents`. Default 200. */
  pageSize?: number;
  /** Allow plain http (local RPC only). */
  allowHttp?: boolean;
}

export class RpcChainReader implements ChainReader {
  private readonly server: rpc.Server;
  private readonly pageSize: number;

  constructor(private readonly opts: RpcChainReaderOptions) {
    this.server = new rpc.Server(opts.rpcUrl, { allowHttp: opts.allowHttp ?? false });
    this.pageSize = opts.pageSize ?? 200;
  }

  async getEscrowState(escrowId: string): Promise<EscrowChainState | null> {
    // Trustless Work v1 stores the escrow under `DataKey::Escrow`, a unit enum
    // variant, which encodes as a one-element vector of the symbol.
    const key = xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: new Address(escrowId).toScAddress(),
        key: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Escrow")]),
        durability: xdr.ContractDataDurability.persistent(),
      }),
    );
    const res = await this.server.getLedgerEntries(key);
    const entry = res.entries[0];
    if (!entry) return null;
    return escrowFromNative(scValToNative(entry.val.contractData().val()));
  }

  async getBalance(holder: string): Promise<EurcBalance> {
    // TODO(verify): SAC balance storage layout. Expected per the Stellar Asset
    // Contract: persistent key Vec[Symbol("Balance"), Address] holding
    // { amount: i128, authorized: bool, clawback: bool }. This applies to
    // contract holders (an escrow); classic accounts keep EURC in a trustline.
    const key = xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: new Address(this.opts.eurcSac).toScAddress(),
        key: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Balance"), new Address(holder).toScVal()]),
        durability: xdr.ContractDataDurability.persistent(),
      }),
    );
    const res = await this.server.getLedgerEntries(key);
    const entry = res.entries[0];
    if (!entry) return { amount: 0n, authorized: true };
    const v = scValToNative(entry.val.contractData().val()) as { amount: bigint; authorized: boolean };
    return { amount: BigInt(v.amount), authorized: Boolean(v.authorized) };
  }

  async getTransfers(holder: string): Promise<EurcTransfer[]> {
    const health = await this.server.getHealth();
    const transferSym = xdr.ScVal.scvSymbol("transfer").toXDR("base64");
    const who = new Address(holder).toScVal().toXDR("base64");
    // TODO(verify): SAC transfer topics are [transfer, from, to, asset] (4
    // segments). Confirm the segment count on the current protocol before
    // relying on the "*" wildcards below.
    const filters: rpc.Api.EventFilter[] = [
      {
        type: "contract",
        contractIds: [this.opts.eurcSac],
        topics: [
          [transferSym, who, "*", "*"],
          [transferSym, "*", who, "*"],
        ],
      },
    ];
    const out: EurcTransfer[] = [];
    let cursor: string | undefined;
    const startLedger = Math.max(this.opts.startLedger, health.oldestLedger);
    for (;;) {
      const page = cursor
        ? await this.server.getEvents({ filters, cursor, limit: this.pageSize })
        : await this.server.getEvents({ filters, startLedger, limit: this.pageSize });
      for (const ev of page.events) {
        const t = decodeTransfer({
          topic: ev.topic,
          value: ev.value,
          txHash: ev.txHash,
          ledger: ev.ledger,
          ledgerClosedAt: ev.ledgerClosedAt,
        });
        if (t) out.push(t);
      }
      if (page.events.length < this.pageSize) break;
      cursor = page.cursor;
    }
    return out;
  }

  async getTxStatus(txHash: string): Promise<TxStatus> {
    // TODO(verify): RPC also keeps transactions for a limited window; an exit
    // older than that reads as not_found. Use an indexer for old exits.
    const res = await this.server.getTransaction(txHash);
    switch (res.status) {
      case rpc.Api.GetTransactionStatus.SUCCESS:
        return "success";
      case rpc.Api.GetTransactionStatus.FAILED:
        return "failed";
      default:
        return "not_found";
    }
  }

  async getTrustline(account: string): Promise<TrustlineState> {
    const asset = new Asset(this.opts.eurc.code, this.opts.eurc.issuer);
    const key = xdr.LedgerKey.trustline(
      new xdr.LedgerKeyTrustLine({
        accountId: Keypair.fromPublicKey(account).xdrAccountId(),
        asset: asset.toTrustLineXDRObject(),
      }),
    );
    const res = await this.server.getLedgerEntries(key);
    const entry = res.entries[0];
    if (!entry) return { exists: false, authorized: false };
    const flags = entry.val.trustLine().flags();
    return { exists: true, authorized: (flags & AUTHORIZED_FLAG) === AUTHORIZED_FLAG };
  }

  async getEventCoverage(): Promise<EventCoverage> {
    const h = await this.server.getHealth();
    const gaps =
      this.opts.startLedger < h.oldestLedger ? [{ fromLedger: this.opts.startLedger, toLedger: h.oldestLedger - 1 }] : [];
    return { oldestLedger: h.oldestLedger, latestLedger: h.latestLedger, gaps };
  }
}

// ---------------------------------------------------------------------------
// Pure decoders (tested against public RPC fixtures)
// ---------------------------------------------------------------------------

/** Escrow struct as `scValToNative` returns it (snake_case field names). */
interface NativeEscrow {
  amount: bigint;
  platform_fee: number;
  roles: { approver: string; receiver: string; platform: string };
  flags: { disputed: boolean; released: boolean; resolved: boolean };
  milestones: Array<{ approved: boolean }>;
}

/** Map the decoded Trustless Work v1 escrow struct to `EscrowChainState`. */
export function escrowFromNative(n: unknown): EscrowChainState {
  const e = n as NativeEscrow;
  return {
    amount: BigInt(e.amount),
    platformFeeBps: Number(e.platform_fee),
    approver: e.roles.approver,
    receiver: e.roles.receiver,
    platform: e.roles.platform,
    flags: { disputed: e.flags.disputed, released: e.flags.released, resolved: e.flags.resolved },
    milestoneApproved: e.milestones.length > 0 && e.milestones.every((m) => m.approved),
  };
}

/** A raw `getEvents` event as JSON-RPC returns it (base64 XDR fields). */
export interface RawRpcEvent {
  contractId: string;
  txHash: string;
  ledger: number;
  ledgerClosedAt: string;
  topic: string[];
  value: string;
}

/** Retention window from a raw JSON-RPC `getEvents` result. */
export function coverageFromRawGetEvents(result: { oldestLedger: number; latestLedger: number }): EventCoverage {
  return { oldestLedger: result.oldestLedger, latestLedger: result.latestLedger, gaps: [] };
}

/** Decode a Trustless Work `tw_fund` event: data is [signer, amount]. */
export function decodeTwFund(raw: RawRpcEvent): {
  escrowId: string;
  signer: string;
  amount: bigint;
  txHash: string;
  ledger: number;
  closedAt: number;
} | null {
  const topic = raw.topic.map((t) => scValToNative(xdr.ScVal.fromXDR(t, "base64")));
  if (topic[0] !== "tw_fund") return null;
  const [signer, amount] = scValToNative(xdr.ScVal.fromXDR(raw.value, "base64")) as [string, bigint];
  return {
    escrowId: raw.contractId,
    signer,
    amount: BigInt(amount),
    txHash: raw.txHash,
    ledger: raw.ledger,
    closedAt: Date.parse(raw.ledgerClosedAt),
  };
}

/**
 * Decode a SAC `transfer` event. Topics: [transfer, from, to, asset]. Data is
 * an i128 amount, or (TODO(verify), CAP-67 muxed form) a map with `amount`.
 */
export function decodeTransfer(ev: {
  topic: xdr.ScVal[];
  value: xdr.ScVal;
  txHash: string;
  ledger: number;
  ledgerClosedAt: string;
}): EurcTransfer | null {
  if (ev.topic.length < 3) return null;
  const name = scValToNative(ev.topic[0] as xdr.ScVal);
  if (name !== "transfer") return null;
  const from = scValToNative(ev.topic[1] as xdr.ScVal) as string;
  const to = scValToNative(ev.topic[2] as xdr.ScVal) as string;
  const data = scValToNative(ev.value) as bigint | { amount: bigint };
  const amount = typeof data === "bigint" ? data : BigInt(data.amount);
  return { txHash: ev.txHash, ledger: ev.ledger, closedAt: Date.parse(ev.ledgerClosedAt), from, to, amount };
}
