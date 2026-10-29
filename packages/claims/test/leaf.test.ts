import { describe, expect, it } from "vitest";
import { Address, StrKey } from "@stellar/stellar-sdk";
import vectors from "./vectors.json";
import {
  addressScValXdr,
  carrierEventRef,
  claimLeaf,
  fromHex,
  newOrderRef,
  newParcelSalt,
  parcelsCommit,
  toHex,
} from "../src/index.js";

describe("claim leaf golden vectors (shared with the Rust guard test)", () => {
  for (const v of vectors.leaves) {
    it(v.name, () => {
      // Strkey round-trip: the vector's escrow address is the contract id it names.
      expect(toHex(StrKey.decodeContract(v.escrow))).toBe(v.escrow_contract_id);
      // XDR(ScVal::Address(C...)) = SCV_ADDRESS(18) || SC_ADDRESS_TYPE_CONTRACT(1) || id.
      expect(toHex(addressScValXdr(v.escrow))).toBe(v.escrow_scval_xdr);

      const salt = fromHex(v.salt);
      expect(toHex(parcelsCommit(salt, v.parcel_number))).toBe(v.parcels_commit);
      expect(
        toHex(carrierEventRef({ parcelNumber: v.parcel_number, statusText: v.carrier_status_text, dateTime: v.carrier_date_time, lang: v.lang })),
      ).toBe(v.carrier_event_ref);

      const leaf = claimLeaf(v.escrow, {
        orderRef: fromHex(v.order_ref),
        parcelsCommit: fromHex(v.parcels_commit),
        carrierEventRef: fromHex(v.carrier_event_ref),
        deliveredAt: BigInt(v.delivered_at),
      });
      expect(toHex(leaf)).toBe(v.leaf);
    });
  }

  it("binds the leaf to the escrow address", () => {
    const v = vectors.leaves[0]!;
    const other = vectors.leaves[1]!;
    const fields = {
      orderRef: fromHex(v.order_ref),
      parcelsCommit: fromHex(v.parcels_commit),
      carrierEventRef: fromHex(v.carrier_event_ref),
      deliveredAt: BigInt(v.delivered_at),
    };
    expect(toHex(claimLeaf(other.escrow, fields))).not.toBe(v.leaf);
  });

  it("rejects wrong-length fields and out-of-range delivered_at", () => {
    const e = vectors.leaves[0]!.escrow;
    const ok = { orderRef: new Uint8Array(32), parcelsCommit: new Uint8Array(32), carrierEventRef: new Uint8Array(32), deliveredAt: 0n };
    expect(() => claimLeaf(e, { ...ok, orderRef: new Uint8Array(31) })).toThrow();
    expect(() => claimLeaf(e, { ...ok, deliveredAt: -1n })).toThrow();
    expect(() => claimLeaf(e, { ...ok, deliveredAt: 1n << 64n })).toThrow();
  });

  it("encodes account addresses too (sanity of the XDR helper)", () => {
    const g = Address.account(Buffer.alloc(32, 7)).toString();
    expect(addressScValXdr(g).length).toBe(44); // 4 + 4 + 4 (key type) + 32
  });
});

describe("parcel commitment", () => {
  const parcel = "TEST-PARCEL-0042";

  it("differs with the salt", () => {
    const a = parcelsCommit(newParcelSalt(), parcel);
    const b = parcelsCommit(newParcelSalt(), parcel);
    expect(toHex(a)).not.toBe(toHex(b));
  });

  it("is not the plain hash of the parcel number, so it cannot be looked up without the salt", async () => {
    const { createHash } = await import("node:crypto");
    const salt = newParcelSalt();
    const c = toHex(parcelsCommit(salt, parcel));
    expect(c).not.toBe(createHash("sha256").update(parcel).digest("hex"));
    // An attacker enumerating parcel numbers with a guessed (zero) salt does not hit it.
    expect(c).not.toBe(toHex(parcelsCommit(new Uint8Array(32), parcel)));
    // The same salt and parcel number reproduce it (needed for disclosure).
    expect(toHex(parcelsCommit(salt, parcel))).toBe(c);
  });

  it("requires a 32-byte salt and a non-empty parcel number", () => {
    expect(() => parcelsCommit(new Uint8Array(16), parcel)).toThrow();
    expect(() => parcelsCommit(newParcelSalt(), "")).toThrow();
  });

  it("order refs are random 32-byte values", () => {
    const a = newOrderRef();
    expect(a.length).toBe(32);
    expect(toHex(a)).not.toBe(toHex(newOrderRef()));
  });
});
