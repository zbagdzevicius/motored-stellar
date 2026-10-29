import { Account, Keypair, MuxedAccount, StrKey } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import {
  type LiquidationAddress,
  RampError,
  assertEscrowReceiver,
  checkOffRampPayment,
  isValidSepaReference,
  offRampTarget,
} from "../src/index.js";

const g = () => Keypair.random().publicKey();
const muxedOf = (base: string, id: string) => new MuxedAccount(new Account(base, "0"), id).accountId();

describe("escrow receiver rule (guard: never a muxed or memo-routed ramp address)", () => {
  it("accepts the seller's own plain G-address", () => {
    expect(() => assertEscrowReceiver(g())).not.toThrow();
  });

  it("rejects a muxed M-address, such as a gateway memoless address", () => {
    const m = muxedOf(g(), "4891237045");
    expect(m.startsWith("M")).toBe(true);
    expect(() => assertEscrowReceiver(m)).toThrow(RampError);
    try {
      assertEscrowReceiver(m);
    } catch (e) {
      expect((e as RampError).code).toBe("RECEIVER_NOT_PLAIN_ACCOUNT");
      expect((e as RampError).message).toMatch(/muxed/);
    }
  });

  it("rejects a contract C-address", () => {
    const c = StrKey.encodeContract(Buffer.alloc(32, 7));
    expect(() => assertEscrowReceiver(c)).toThrow(/contract/);
  });

  it("rejects garbage", () => {
    expect(() => assertEscrowReceiver("GNOTANADDRESS")).toThrow(RampError);
  });

  it("rejects a memo-required gateway deposit address even though it is a valid G-address", () => {
    const omnibus = g();
    try {
      assertEscrowReceiver(omnibus, [g(), omnibus]);
      expect.unreachable();
    } catch (e) {
      expect((e as RampError).code).toBe("RECEIVER_IS_RAMP_ADDRESS");
    }
  });
});

describe("off-ramp payment target and pre-sign check", () => {
  const omnibus = g();
  const base: LiquidationAddress = {
    id: "la_1",
    customerId: "c",
    address: omnibus,
    memo: "12345",
    state: "active",
  };

  it("prefers the memoless address when present", () => {
    const memoless = muxedOf(omnibus, "12345");
    expect(offRampTarget({ ...base, memolessAddress: memoless })).toEqual({
      kind: "memoless",
      destination: memoless,
    });
  });

  it("falls back to address plus memo", () => {
    expect(offRampTarget(base)).toEqual({ kind: "memo", destination: omnibus, memo: "12345" });
  });

  it("refuses a liquidation address with neither", () => {
    const { memo: _m, ...noMemo } = base;
    expect(() => offRampTarget(noMemo)).toThrow(RampError);
  });

  it("accepts the stored address with its memo, and the memoless address without one", () => {
    const memoless = muxedOf(omnibus, "12345");
    const la = { ...base, memolessAddress: memoless };
    expect(() => checkOffRampPayment(la, { destination: omnibus, memo: "12345" })).not.toThrow();
    expect(() => checkOffRampPayment(la, { destination: memoless })).not.toThrow();
  });

  it("rejects a missing or wrong memo, a different destination, or a memo on a memoless payment", () => {
    const memoless = muxedOf(omnibus, "12345");
    const la = { ...base, memolessAddress: memoless };
    const bad = [
      { destination: omnibus },
      { destination: omnibus, memo: "99999" },
      { destination: g(), memo: "12345" },
      { destination: memoless, memo: "12345" },
    ];
    for (const p of bad) {
      expect(() => checkOffRampPayment(la, p)).toThrow(RampError);
    }
  });

  it("rejects a deactivated liquidation address", () => {
    expect(() =>
      checkOffRampPayment({ ...base, state: "deactivated" }, { destination: omnibus, memo: "12345" }),
    ).toThrow(/not active/);
  });
});

describe("SEPA reference rule", () => {
  it("follows the documented charset and 6-140 length", () => {
    expect(isValidSepaReference("Order 12-A/3 & co.")).toBe(true);
    expect(isValidSepaReference("abcde")).toBe(false);
    expect(isValidSepaReference("a".repeat(141))).toBe(false);
    expect(isValidSepaReference("under_score")).toBe(false);
  });
});
