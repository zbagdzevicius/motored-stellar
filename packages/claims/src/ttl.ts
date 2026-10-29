// TTL upkeep: ledger keys for everything the release path must keep live, and
// ExtendFootprintTTL transactions over them. ExtendFootprintTTL needs no
// authorisation from the entries' owners, so the anchoring job (or anyone) can
// submit it. Ported from the lab's extension cost probe.
//
// What to extend (architecture, anchoring job):
//   - claim registry: instance + each Root(batch_id) entry still inside a payout window
//   - guard: instance + each open Esc(escrow) registration
//   - each open escrow's instance (Trustless Work's own extend_contract_ttl extends
//     only the escrow's data entry, not its instance)
//   - each open escrow's balance entry in the asset's Stellar Asset Contract
//   - the Wasm code entries (guard, registry, Trustless Work escrow)
import {
  Address,
  type Account,
  Operation,
  SorobanDataBuilder,
  type Transaction,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-sdk";
import { assertLen, toU64 } from "./bytes.js";

const persistent = () => xdr.ContractDataDurability.persistent();

/** Persistent contract-data key `key` of contract `contractId`. */
export function contractDataKey(contractId: string, key: xdr.ScVal): xdr.LedgerKey {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({ contract: new Address(contractId).toScAddress(), key, durability: persistent() }),
  );
}

/** A contract's instance entry (holds instance storage and the Wasm reference). */
export const instanceKey = (contractId: string): xdr.LedgerKey =>
  contractDataKey(contractId, xdr.ScVal.scvLedgerKeyContractInstance());

/** A Wasm code entry by its 32-byte hash. */
export const wasmCodeKey = (hash: Uint8Array): xdr.LedgerKey =>
  xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash: Buffer.from(assertLen(hash, 32, "wasm hash")) }));

/** A `#[contracttype]` enum variant with one value encodes as vec[symbol(name), value]. */
const variant = (name: string, v: xdr.ScVal) => xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(name), v]);

/** Claim registry `Key::Root(batch_id)`. */
export const registryRootKey = (registry: string, batchId: bigint | number): xdr.LedgerKey =>
  contractDataKey(registry, variant("Root", nativeToScVal(toU64(batchId), { type: "u64" })));

/** Guard `DK::Esc(escrow)` registration entry. */
export const guardRegistrationKey = (guard: string, escrow: string): xdr.LedgerKey =>
  contractDataKey(guard, variant("Esc", new Address(escrow).toScVal()));

/**
 * The balance entry of `holder` in a Stellar Asset Contract: persistent
 * `Balance(holder)`. Only contract holders (C...) have one; account holders keep
 * their balance in a classic trustline.
 * TODO(verify): key shape taken from the SAC's DataKey::Balance(Address); confirm
 * against a live getLedgerEntries read before relying on it in production.
 */
export const sacBalanceKey = (sac: string, holder: string): xdr.LedgerKey =>
  contractDataKey(sac, variant("Balance", new Address(holder).toScVal()));

export interface UpkeepTargets {
  registry?: { contractId: string; batchIds?: Array<bigint | number> };
  guard?: { contractId: string; openEscrows?: string[] };
  /** Open escrows: instance and SAC balance entries are extended. */
  escrows?: { contractIds: string[]; sac?: string };
  /** Wasm hashes (guard, registry, Trustless Work escrow). */
  wasmHashes?: Uint8Array[];
}

/** Every ledger key the upkeep run should extend, de-duplicated, in a stable order. */
export function upkeepKeys(t: UpkeepTargets): xdr.LedgerKey[] {
  const keys: xdr.LedgerKey[] = [];
  if (t.registry) {
    keys.push(instanceKey(t.registry.contractId));
    for (const b of t.registry.batchIds ?? []) keys.push(registryRootKey(t.registry.contractId, b));
  }
  if (t.guard) {
    keys.push(instanceKey(t.guard.contractId));
    for (const e of t.guard.openEscrows ?? []) keys.push(guardRegistrationKey(t.guard.contractId, e));
  }
  if (t.escrows) {
    for (const e of t.escrows.contractIds) {
      keys.push(instanceKey(e));
      if (t.escrows.sac) keys.push(sacBalanceKey(t.escrows.sac, e));
    }
  }
  for (const h of t.wasmHashes ?? []) keys.push(wasmCodeKey(h));
  const seen = new Set<string>();
  return keys.filter((k) => {
    const id = k.toXDR("base64");
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/** Splits keys into footprints of at most `max` entries (one transaction each). */
export function chunkKeys(keys: xdr.LedgerKey[], max = 25): xdr.LedgerKey[][] {
  // TODO(verify): 25 is a conservative default; the per-transaction read-entry limit
  // is a network setting and should be read from the live config.
  if (!Number.isInteger(max) || max < 1) throw new RangeError("max must be >= 1");
  const out: xdr.LedgerKey[][] = [];
  for (let i = 0; i < keys.length; i += max) out.push(keys.slice(i, i + max));
  return out;
}

export interface ExtendTtlTxOptions {
  source: Account;
  networkPassphrase: string;
  keys: xdr.LedgerKey[];
  /** Ledgers from now the entries must live until (`extend_to`). */
  extendTo: number;
  /** Inclusion fee in stroops; the resource fee comes from simulation. */
  fee?: string;
  timeoutSeconds?: number;
}

/**
 * An unsigned ExtendFootprintTTL transaction with `keys` as the read-only footprint.
 * Simulate it (rpc.assembleTransaction) to set resource fees before signing. The
 * architecture extends in short steps because rent grows with the extension.
 */
export function buildExtendTtlTx(o: ExtendTtlTxOptions): Transaction {
  if (o.keys.length === 0) throw new Error("no keys to extend");
  if (!Number.isInteger(o.extendTo) || o.extendTo <= 0) throw new RangeError("extendTo must be a positive ledger count");
  return new TransactionBuilder(o.source, { fee: o.fee ?? "100", networkPassphrase: o.networkPassphrase })
    .addOperation(Operation.extendFootprintTtl({ extendTo: o.extendTo }))
    .setSorobanData(new SorobanDataBuilder().setReadOnly(o.keys).build())
    .setTimeout(o.timeoutSeconds ?? 60)
    .build();
}
