// The delivery-claim leaf, byte for byte as the guard contract builds it.
//
// Source of truth: `fn leaf` in contracts/guard/src/lib.rs:
//
//   leaf = sha256(0x01 || XDR(ScVal::Address(E)) || order_ref || parcels_commit
//                 || carrier_event_ref || u64_be(delivered_at))
//
// The leaf is bound to the escrow address E, so a claim for one escrow never pays
// another. Golden vectors shared with the Rust test live in test/vectors.json.
import { Address } from "@stellar/stellar-sdk";
import { assertLen, concat, hmacSha256, random, sha256, toU64, u64be, utf8 } from "./bytes.js";

/** Domain tag of a delivery-claim leaf. Tag 0x00 is reserved for field-level leaves of other formats. */
export const TAG_CLAIM_LEAF = 0x01;

/** The four fields that, with the escrow address, make up a leaf. */
export interface ClaimFields {
  /** Random 32-byte value per order. Never a database ID. */
  orderRef: Uint8Array;
  /** HMAC-SHA256(per-order secret salt, parcel number). See {@link parcelsCommit}. */
  parcelsCommit: Uint8Array;
  /** Hash of the carrier's delivered status and timestamp. See {@link carrierEventRef}. */
  carrierEventRef: Uint8Array;
  /** Delivery time, unix seconds (u64). */
  deliveredAt: bigint;
}

/**
 * A claim as the guard's `Claim` struct holds it: the leaf fields plus where the
 * leaf sits in an anchored batch.
 */
export interface Claim extends ClaimFields {
  batchId: bigint;
  proof: Uint8Array[];
  index: number;
}

/** XDR of `ScVal::Address(addr)` for a G... or C... strkey, as `Address::to_xdr` encodes it. */
export function addressScValXdr(addr: string): Uint8Array {
  return new Uint8Array(new Address(addr).toScVal().toXDR());
}

/** Builds the 32-byte claim leaf for escrow `escrow` (a C... contract address). */
export function claimLeaf(escrow: string, c: ClaimFields): Uint8Array {
  return sha256(
    concat(
      Uint8Array.of(TAG_CLAIM_LEAF),
      addressScValXdr(escrow),
      assertLen(c.orderRef, 32, "orderRef"),
      assertLen(c.parcelsCommit, 32, "parcelsCommit"),
      assertLen(c.carrierEventRef, 32, "carrierEventRef"),
      u64be(toU64(c.deliveredAt)),
    ),
  );
}

/** A fresh random order reference (32 bytes). */
export const newOrderRef = (): Uint8Array => random(32);

/** A fresh per-order secret salt (32 bytes) for {@link parcelsCommit}. */
export const newParcelSalt = (): Uint8Array => random(32);

/**
 * parcels_commit = HMAC-SHA256(salt, UTF-8 parcel number).
 *
 * The salt is a per-order secret kept off-chain, so a parcel number (which is short
 * and enumerable) cannot be brute-forced from the commitment and linked to the
 * carrier's public tracking page. Pass the parcel number exactly as the carrier
 * reports it; no normalisation is applied.
 *
 * TODO(verify): the published format commits to one parcel number per order. How
 * multi-parcel orders are committed is not specified yet.
 */
export function parcelsCommit(salt: Uint8Array, parcelNumber: string): Uint8Array {
  assertLen(salt, 32, "salt");
  if (parcelNumber.length === 0) throw new Error("parcel number is empty");
  return hmacSha256(salt, utf8(parcelNumber));
}

/** Inputs to {@link carrierEventRef}, all taken verbatim from the carrier's tracking response. */
export interface CarrierEvent {
  parcelNumber: string;
  /** Carrier's delivered status text, e.g. the "delivered to consignee" status. */
  statusText: string;
  /** Carrier's event timestamp text, exactly as returned. */
  dateTime: string;
  /** Language the status text was requested in. Default "en". */
  lang?: string;
}

/**
 * carrier_event_ref = sha256(parcel number || status text || dateTime || "lang=" + lang),
 * each part UTF-8, concatenated without separators, as published in the
 * architecture's leaf format. It lets anyone holding the carrier's response re-derive
 * the reference, without putting the response on-chain.
 */
export function carrierEventRef(e: CarrierEvent): Uint8Array {
  return sha256(concat(utf8(e.parcelNumber), utf8(e.statusText), utf8(e.dateTime), utf8(`lang=${e.lang ?? "en"}`)));
}
