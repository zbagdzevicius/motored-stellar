import { Asset, Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { InMemoryAccountReader, canReceive, hasTrustline, trustlineStatus } from "../src/index.js";
import { randomContract } from "./fixtures.js";

const issuer = Keypair.random().publicKey();
const xeur = new Asset("XEUR", issuer);
const other = new Asset("XEUR", Keypair.random().publicKey()); // same code, different issuer

describe("trustline detection", () => {
  const withLine = Keypair.random().publicKey();
  const withoutLine = Keypair.random().publicKey();
  const frozen = Keypair.random().publicKey();
  const missing = Keypair.random().publicKey();
  const reader = new InMemoryAccountReader()
    .putAccount(withLine, [
      { assetCode: "native", balance: "0.0000000" },
      { assetCode: "XEUR", assetIssuer: issuer, balance: "10.0000000", sponsor: Keypair.random().publicKey() },
    ])
    .putAccount(withoutLine, [
      { assetCode: "native", balance: "1.0000000" },
      { assetCode: "XEUR", assetIssuer: other.getIssuer(), balance: "5.0000000" },
    ])
    .putAccount(frozen, [{ assetCode: "XEUR", assetIssuer: issuer, balance: "1.0000000", authorized: false }]);

  it("reports each state", async () => {
    expect((await trustlineStatus(reader, withLine, xeur)).kind).toBe("present");
    expect((await trustlineStatus(reader, withoutLine, xeur)).kind).toBe("missing");
    expect((await trustlineStatus(reader, frozen, xeur)).kind).toBe("frozen");
    expect((await trustlineStatus(reader, missing, xeur)).kind).toBe("no-account");
    expect(await hasTrustline(reader, withLine, xeur)).toBe(true);
    expect(await hasTrustline(reader, withoutLine, xeur)).toBe(false);
  });

  it("matches on issuer, not only on code", async () => {
    expect(await hasTrustline(reader, withoutLine, other)).toBe(true);
    expect(await hasTrustline(reader, withoutLine, xeur)).toBe(false);
  });

  it("detects a trustline the user removed", async () => {
    const r = new InMemoryAccountReader().putAccount(withLine, [
      { assetCode: "XEUR", assetIssuer: issuer, balance: "0.0000000" },
    ]);
    expect(await hasTrustline(r, withLine, xeur)).toBe(true);
    r.putAccount(withLine, [{ assetCode: "native", balance: "0.0000000" }]);
    expect((await trustlineStatus(r, withLine, xeur)).kind).toBe("missing");
  });

  it("refuses to check a trustline for XLM", async () => {
    await expect(trustlineStatus(reader, withLine, Asset.native())).rejects.toThrow();
  });

  it("lets contract addresses receive without a trustline", async () => {
    expect(await canReceive(reader, randomContract(), xeur)).toEqual({ ok: true, reason: "contract-address" });
    expect(await canReceive(reader, withLine, xeur)).toEqual({ ok: true, reason: "trustline-present" });
    expect(await canReceive(reader, withoutLine, xeur)).toEqual({ ok: false, reason: "missing-trustline" });
    expect(await canReceive(reader, frozen, xeur)).toEqual({ ok: false, reason: "frozen-trustline" });
    expect(await canReceive(reader, missing, xeur)).toEqual({ ok: false, reason: "no-account" });
    expect(await canReceive(reader, "not-an-address", xeur)).toEqual({ ok: false, reason: "invalid-address" });
  });
});
