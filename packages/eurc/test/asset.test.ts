import { Asset, Keypair, Networks } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import {
  EURC_MAINNET_ISSUER,
  EURC_MAINNET_ISSUER_FLAGS,
  EURC_MAINNET_SAC,
  EURC_TESTNET_ISSUER,
  HorizonRpcSubmitter,
  MAINNET_REFERENCE,
  TESTNET,
  amountToUnits,
  assertTestnet,
  eurcMainnetSacDerived,
  eurcTestnet,
  eurcTestnetSac,
  sacContractId,
  standinAsset,
  unitsToAmount,
} from "../src/index.js";

describe("EURC constants", () => {
  it("uses Circle's documented issuers", () => {
    expect(eurcTestnet().getIssuer()).toBe(EURC_TESTNET_ISSUER);
    expect(EURC_TESTNET_ISSUER.startsWith("GB3Q6QDZ")).toBe(true);
    expect(EURC_MAINNET_ISSUER.startsWith("GDHU6WRG")).toBe(true);
  });

  it("records the mainnet issuer flags (no auth required, no clawback)", () => {
    expect(EURC_MAINNET_ISSUER_FLAGS.auth_required).toBe(false);
    expect(EURC_MAINNET_ISSUER_FLAGS.auth_clawback_enabled).toBe(false);
  });

  it("re-derives the documented mainnet SAC id (reference only)", () => {
    expect(eurcMainnetSacDerived()).toBe(EURC_MAINNET_SAC);
  });
});

describe("SAC derivation", () => {
  it("matches stellar-sdk Asset.contractId for testnet EURC", () => {
    expect(eurcTestnetSac()).toBe(eurcTestnet().contractId(Networks.TESTNET));
  });

  it("matches stellar-sdk for a random stand-in asset", () => {
    const xeur = standinAsset(Keypair.random().publicKey());
    expect(sacContractId(xeur, Networks.TESTNET)).toBe(xeur.contractId(Networks.TESTNET));
  });

  it("depends on the network passphrase", () => {
    const a = eurcTestnet();
    expect(sacContractId(a, Networks.TESTNET)).not.toBe(sacContractId(a, Networks.PUBLIC));
  });

  it("matches stellar-sdk for native XLM", () => {
    expect(sacContractId(Asset.native(), Networks.TESTNET)).toBe(Asset.native().contractId(Networks.TESTNET));
  });
});

describe("amounts", () => {
  it("round-trips 7-decimal units", () => {
    expect(unitsToAmount(1_000_000_000n)).toBe("100.0000000");
    expect(unitsToAmount(1n)).toBe("0.0000001");
    expect(amountToUnits("100")).toBe(1_000_000_000n);
    expect(amountToUnits("0.0000001")).toBe(1n);
    expect(amountToUnits(unitsToAmount(123_456_789n))).toBe(123_456_789n);
  });

  it("rejects malformed amounts", () => {
    expect(() => amountToUnits("1.00000001")).toThrow();
    expect(() => amountToUnits("-1")).toThrow();
    expect(() => unitsToAmount(-1n)).toThrow();
  });
});

describe("testnet only", () => {
  it("refuses the public network as a submit target", () => {
    expect(() => assertTestnet(MAINNET_REFERENCE.passphrase)).toThrow(/testnet-only/);
    expect(() => assertTestnet(TESTNET.passphrase)).not.toThrow();
    expect(
      () => new HorizonRpcSubmitter({ ...TESTNET, name: "mainnet", passphrase: Networks.PUBLIC }),
    ).toThrow(/testnet-only/);
  });
});
