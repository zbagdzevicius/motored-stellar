// ScVal and JSON encodings of a claim.
import { xdr, nativeToScVal } from "@stellar/stellar-sdk";
import { fromHex, toHex, toU64 } from "./bytes.js";
import type { Claim } from "./leaf.js";

const sym = (s: string) => xdr.ScVal.scvSymbol(s);
const bytes = (b: Uint8Array) => xdr.ScVal.scvBytes(Buffer.from(b));

/**
 * The guard's `Claim` contracttype as an ScVal map. Soroban encodes a struct as a
 * map keyed by field-name symbols in sorted order (the lab's testnet runs encoded
 * the claim the same way, under an earlier field name for carrier_event_ref).
 */
export function claimToScVal(c: Claim): xdr.ScVal {
  const fields: Record<string, xdr.ScVal> = {
    batch_id: nativeToScVal(toU64(c.batchId), { type: "u64" }),
    carrier_event_ref: bytes(c.carrierEventRef),
    delivered_at: nativeToScVal(toU64(c.deliveredAt), { type: "u64" }),
    index: nativeToScVal(c.index, { type: "u32" }),
    order_ref: bytes(c.orderRef),
    parcels_commit: bytes(c.parcelsCommit),
    proof: xdr.ScVal.scvVec(c.proof.map(bytes)),
  };
  return xdr.ScVal.scvMap(
    Object.keys(fields)
      .sort()
      .map((k) => new xdr.ScMapEntry({ key: sym(k), val: fields[k]! })),
  );
}

/**
 * A self-contained, public claim bundle: what an operator hands out so anyone can
 * re-check a released order's claim (scripts/claims/recheck.ts). Contains no salt
 * and no parcel number.
 */
export interface ClaimBundleJson {
  network: "testnet" | "mainnet";
  /** Claim registry contract (C...). */
  registry: string;
  /** Escrow contract (C...). */
  escrow: string;
  claim: {
    order_ref: string;
    parcels_commit: string;
    carrier_event_ref: string;
    delivered_at: string;
    batch_id: string;
    proof: string[];
    index: number;
  };
}

export function claimToJson(c: Claim): ClaimBundleJson["claim"] {
  return {
    order_ref: toHex(c.orderRef),
    parcels_commit: toHex(c.parcelsCommit),
    carrier_event_ref: toHex(c.carrierEventRef),
    delivered_at: toU64(c.deliveredAt).toString(),
    batch_id: toU64(c.batchId).toString(),
    proof: c.proof.map(toHex),
    index: c.index,
  };
}

export function claimFromJson(j: ClaimBundleJson["claim"]): Claim {
  return {
    orderRef: fromHex(j.order_ref),
    parcelsCommit: fromHex(j.parcels_commit),
    carrierEventRef: fromHex(j.carrier_event_ref),
    deliveredAt: toU64(BigInt(j.delivered_at)),
    batchId: toU64(BigInt(j.batch_id)),
    proof: j.proof.map(fromHex),
    index: j.index,
  };
}
