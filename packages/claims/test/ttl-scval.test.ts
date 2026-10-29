import { describe, expect, it } from "vitest";
import { Account, Address, Keypair, Networks, nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";
import {
  SorobanRegistryClient,
  RegistryErrorCode,
  buildExtendTtlTx,
  chunkKeys,
  claimToScVal,
  contractErrorCode,
  guardRegistrationKey,
  instanceKey,
  random,
  registryRootKey,
  sacBalanceKey,
  upkeepKeys,
  wasmCodeKey,
} from "../src/index.js";

const C = () => Address.contract(Buffer.from(random(32))).toString();

describe("TTL upkeep", () => {
  it("builds the expected footprint keys", () => {
    const registry = C(), guard = C(), sac = C(), e1 = C(), e2 = C();
    const twHash = random(32);
    const keys = upkeepKeys({
      registry: { contractId: registry, batchIds: [489_260n] },
      guard: { contractId: guard, openEscrows: [e1, e2] },
      escrows: { contractIds: [e1, e2], sac },
      wasmHashes: [twHash, twHash], // duplicate is dropped
    });
    const expected = [
      instanceKey(registry),
      registryRootKey(registry, 489_260n),
      instanceKey(guard),
      guardRegistrationKey(guard, e1),
      guardRegistrationKey(guard, e2),
      instanceKey(e1),
      sacBalanceKey(sac, e1),
      instanceKey(e2),
      sacBalanceKey(sac, e2),
      wasmCodeKey(twHash),
    ];
    expect(keys.map((k) => k.toXDR("base64"))).toEqual(expected.map((k) => k.toXDR("base64")));

    // Registry root key is Key::Root(u64) = vec[symbol("Root"), u64].
    const rk = registryRootKey(registry, 5n).contractData();
    expect(scValToNative(rk.key())).toEqual(["Root", 5n]);
    expect(rk.durability()).toEqual(xdr.ContractDataDurability.persistent());
    // Guard registration key is DK::Esc(Address), as read on testnet by the lab.
    expect(scValToNative(guardRegistrationKey(guard, e1).contractData().key())).toEqual(["Esc", e1]);
  });

  it("puts the keys into a read-only footprint of one ExtendFootprintTTL op", () => {
    const keys = upkeepKeys({ registry: { contractId: C(), batchIds: [1n, 2n] } });
    const tx = buildExtendTtlTx({
      source: new Account(Keypair.random().publicKey(), "1"),
      networkPassphrase: Networks.TESTNET,
      keys,
      extendTo: 17_280,
    });
    expect(tx.operations).toHaveLength(1);
    expect(tx.operations[0]!.type).toBe("extendFootprintTtl");
    const fp = tx.toEnvelope().v1().tx().ext().sorobanData().resources().footprint();
    expect(fp.readOnly().map((k) => k.toXDR("base64"))).toEqual(keys.map((k) => k.toXDR("base64")));
    expect(fp.readWrite()).toHaveLength(0);
  });

  it("chunks large key sets", () => {
    const keys = Array.from({ length: 60 }, () => instanceKey(C()));
    expect(chunkKeys(keys, 25).map((c) => c.length)).toEqual([25, 25, 10]);
  });
});

describe("claim ScVal", () => {
  it("is a map with sorted field symbols matching the guard's Claim struct", () => {
    const v = claimToScVal({
      orderRef: random(32), parcelsCommit: random(32), carrierEventRef: random(32),
      deliveredAt: 1n, batchId: 2n, proof: [random(32)], index: 1,
    });
    const keys = v.map()!.map((e) => e.key().sym().toString());
    expect(keys).toEqual(["batch_id", "carrier_event_ref", "delivered_at", "index", "order_ref", "parcels_commit", "proof"]);
  });
});

describe("SorobanRegistryClient (stubbed RPC)", () => {
  const stub = (sim: unknown) =>
    ({ simulateTransaction: async () => sim }) as unknown as ConstructorParameters<typeof SorobanRegistryClient>[0]["rpc"];

  it("maps contract errors to RegistryError codes", async () => {
    expect(contractErrorCode("HostError: Error(Contract, #5)")).toBe(5);
    const c = new SorobanRegistryClient({
      rpc: stub({ error: "HostError: Error(Contract, #6)", events: [], _parsed: true }),
      networkPassphrase: Networks.TESTNET,
      contractId: C(),
    });
    await expect(c.anchoredAt(1n)).rejects.toMatchObject({ code: RegistryErrorCode.Revoked });
  });

  it("reads anchored_at and verify by simulation", async () => {
    const at = new SorobanRegistryClient({
      rpc: stub({ result: { retval: nativeToScVal(1_761_336_000n, { type: "u64" }), auth: [] }, events: [], _parsed: true }),
      networkPassphrase: Networks.TESTNET,
      contractId: C(),
    });
    expect(await at.anchoredAt(1n)).toBe(1_761_336_000n);
    const v = new SorobanRegistryClient({
      rpc: stub({ result: { retval: xdr.ScVal.scvBool(true), auth: [] }, events: [], _parsed: true }),
      networkPassphrase: Networks.TESTNET,
      contractId: C(),
    });
    expect(await v.verify(1n, random(32), [], 0)).toBe(true);
    await expect(v.verify(1n, random(32), Array.from({ length: 33 }, () => random(32)), 0)).rejects.toMatchObject({
      code: RegistryErrorCode.ProofTooLong,
    });
  });
});
