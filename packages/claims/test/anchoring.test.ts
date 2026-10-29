import { describe, expect, it } from "vitest";
import { Address } from "@stellar/stellar-sdk";
import {
  ClaimAnchoringJob,
  type DeliveredEvent,
  HOUR,
  InMemoryClaimStore,
  InMemoryDeliveryOracle,
  InMemoryRegistry,
  InMemorySaltStore,
  ManualClock,
  RegistryError,
  RegistryErrorCode,
  claimFromJson,
  claimToJson,
  claimLeaf,
  newOrderRef,
  random,
  recheckClaim,
  toHex,
} from "../src/index.js";

const escrow = () => Address.contract(Buffer.from(random(32))).toString();

function delivered(n: number, at: number): DeliveredEvent[] {
  return Array.from({ length: n }, (_, i) => ({
    escrow: escrow(),
    orderRef: newOrderRef(),
    parcelNumber: `TEST-PARCEL-${1000 + i}`,
    carrierStatusText: "Delivered",
    carrierDateTime: new Date(at * 1000).toISOString(),
    deliveredAt: at,
  }));
}

function setup() {
  const clock = new ManualClock(1_761_336_000); // an hour boundary
  const oracle = new InMemoryDeliveryOracle();
  const salts = new InMemorySaltStore();
  const registry = new InMemoryRegistry(clock);
  const store = new InMemoryClaimStore();
  const job = new ClaimAnchoringJob({ oracle, salts, registry, store, clock });
  return { clock, oracle, salts, registry, store, job };
}

describe("InMemoryRegistry mirrors the contract", () => {
  it("is write-once, stamps anchor time, and revocation is permanent", async () => {
    const clock = new ManualClock(100);
    const r = new InMemoryRegistry(clock);
    const root = random(32);
    await r.anchor(1n, root);
    await expect(r.anchor(1n, random(32))).rejects.toMatchObject({ code: RegistryErrorCode.RootExists });
    expect(await r.anchoredAt(1n)).toBe(100n);
    await expect(r.anchoredAt(2n)).rejects.toBeInstanceOf(RegistryError);
    expect(await r.verify(1n, root, [], 0)).toBe(true);
    await r.revoke(1n);
    expect(await r.verify(1n, root, [], 0)).toBe(false);
    await expect(r.anchoredAt(1n)).rejects.toMatchObject({ code: RegistryErrorCode.Revoked });
    await expect(r.verify(1n, root, Array.from({ length: 33 }, () => random(32)), 0)).rejects.toMatchObject({
      code: RegistryErrorCode.ProofTooLong,
    });
  });
});

describe("ClaimAnchoringJob", () => {
  it("ingests, batches, anchors and every claim verifies against the registry", async () => {
    const { clock, oracle, registry, job } = setup();
    const events = delivered(7, clock.nowSeconds() - 600);
    oracle.push(...events);
    expect(await job.ingest()).toBe(7);
    expect(await job.ingest()).toBe(0); // cursor advanced

    const b = await job.anchorBatch();
    expect(b).toBeDefined();
    expect(b!.batchId).toBe(BigInt(clock.nowSeconds() / HOUR));
    expect(b!.depth).toBe(3);
    expect(toHex(registry.rootOf(b!.batchId)!)).toBe(toHex(b!.root));
    for (const c of b!.claims) {
      expect(await registry.verify(c.batchId, claimLeaf(c.escrow, c), c.proof, c.index)).toBe(true);
    }
    expect(await job.anchorBatch()).toBeUndefined(); // nothing pending
  });

  it("queues one claim per escrow even if the carrier reports twice", async () => {
    const { oracle, job } = setup();
    const [e] = delivered(1, 1_761_330_000);
    oracle.push(e!, { ...e!, carrierDateTime: "later scan" });
    expect(await job.ingest()).toBe(1);
  });

  it("uses strictly increasing batch ids within one window", async () => {
    const { oracle, job } = setup();
    oracle.push(...delivered(2, 1_761_330_000));
    await job.ingest();
    const a = await job.anchorBatch();
    oracle.push(...delivered(1, 1_761_330_100));
    await job.ingest();
    const b = await job.anchorBatch();
    expect(b!.batchId).toBe(a!.batchId + 1n);
  });

  it("public re-check passes for an anchored claim and fails after revocation", async () => {
    const { oracle, salts, registry, job } = setup();
    const [e] = delivered(3, 1_761_330_000);
    oracle.push(e!);
    await job.ingest();
    await job.anchorBatch();
    const c = (await job.claimFor(e!.escrow))!;
    // Round-trip through the public bundle format.
    const claim = claimFromJson(claimToJson(c));

    const salt = (await salts.get(e!.orderRef))!;
    const ok = await recheckClaim(registry, e!.escrow, claim, {
      salt,
      parcelNumber: e!.parcelNumber,
      carrierEvent: { parcelNumber: e!.parcelNumber, statusText: e!.carrierStatusText, dateTime: e!.carrierDateTime },
    });
    expect(ok.ok).toBe(true);
    expect(ok.anchoredAt).toBe(1_761_336_000n);
    expect(ok.parcelsCommitMatches).toBe(true);

    const wrongEscrow = await recheckClaim(registry, escrow(), claim);
    expect(wrongEscrow.ok).toBe(false);

    await registry.revoke(c.batchId);
    const revoked = await recheckClaim(registry, e!.escrow, claim);
    expect(revoked.ok).toBe(false);
    expect(revoked.onChainVerify).toBe(false);
  });

  it("accepts a retried anchor only if the stored root is identical", async () => {
    const { clock, oracle, registry, store, salts } = setup();
    oracle.push(...delivered(2, 1_761_330_000));
    // Someone else (or a crashed run with other claims) already holds this window's id.
    await registry.anchor(BigInt(clock.nowSeconds() / HOUR), random(32));
    const job = new ClaimAnchoringJob({ oracle, salts, registry, store, clock });
    await job.ingest();
    await expect(job.anchorBatch()).rejects.toMatchObject({ code: RegistryErrorCode.RootExists });
  });
});
