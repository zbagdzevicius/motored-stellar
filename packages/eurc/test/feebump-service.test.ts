import { Networks } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import {
  FeeBumpService,
  FixedWindowRateLimiter,
  InMemorySubmitter,
  KeypairSigner,
  ManualClock,
  attachSignature,
  buildUserSourcedSponsoredTrustlineTx,
  hasValidSignatureFrom,
  unlimited,
  type RateLimiter,
} from "../src/index.js";
import { Account, Keypair, Operation, NP, fundEscrow, innerTx, world } from "./fixtures.js";

function setup(opts: { rateLimiter?: RateLimiter; feeBumpCap?: bigint } = {}) {
  const w = world();
  const submitter = new InMemorySubmitter(NP);
  const policy = w.policy(
    opts.feeBumpCap === undefined
      ? {}
      : { caps: { classicFeePerOp: 10_000n, sorobanTotalFee: 10_000_000n, feeBumpTotalFee: opts.feeBumpCap } },
  );
  const service = new FeeBumpService({ policy, sponsor: w.sponsor, submitter, rateLimiter: opts.rateLimiter ?? unlimited });
  return { ...w, submitter, service };
}

const rampPay = (w: ReturnType<typeof setup>) =>
  innerTx(w.buyer, [Operation.payment({ destination: w.rampAddress, asset: w.xeur, amount: "10" })]);

describe("fee-bump service", () => {
  it("wraps an allowed classic tx with the sponsor as fee source and submits it", async () => {
    const w = setup();
    const inner = await rampPay(w);
    const r = await w.service.bumpAndSubmit(inner);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.feeBump.feeSource).toBe(w.sponsor.publicKey());
    expect(Buffer.from(r.feeBump.innerTransaction.hash()).equals(inner.hash())).toBe(true);
    expect(hasValidSignatureFrom(r.feeBump, w.sponsor.publicKey())).toBe(true);
    expect(w.submitter.submitted).toEqual([r.feeBump]);
    expect(w.submitter.simulated).toHaveLength(0); // classic: no simulation
    // 1 inner op + the fee-bump itself, at BASE_FEE each.
    expect(r.feeBump.fee).toBe("200");
  });

  it("re-simulates an allowed Soroban tx before signing", async () => {
    const w = setup();
    const inner = await innerTx(w.buyer, [fundEscrow(w.escrow, w.buyer.publicKey())], { resourceFee: 200_000 });
    const r = await w.service.bumpAndSubmit(inner);
    expect(r).toMatchObject({ ok: true, action: { kind: "fund_escrow" } });
    expect(w.submitter.simulated).toHaveLength(1);
    expect(w.submitter.submitted).toHaveLength(1);
  });

  it("signs and submits nothing for a rejected tx", async () => {
    const w = setup();
    const inner = await innerTx(w.buyer, [
      Operation.payment({ destination: Keypair.random().publicKey(), asset: w.xeur, amount: "10" }),
    ]);
    expect(await w.service.bumpAndSubmit(inner)).toMatchObject({ ok: false, reason: "destination-not-allowed" });
    expect(w.submitter.submitted).toHaveLength(0);
    expect(w.submitter.simulated).toHaveLength(0);
  });

  it("refuses when the simulation fails", async () => {
    const w = setup();
    w.submitter.simulateResult = { ok: false, error: "HostError: Error(Contract, #10)" };
    const inner = await innerTx(w.buyer, [fundEscrow(w.escrow, w.buyer.publicKey())], { resourceFee: 200_000 });
    expect(await w.service.bumpAndSubmit(inner)).toMatchObject({ ok: false, reason: "simulation-failed" });
    expect(w.submitter.submitted).toHaveLength(0);
  });

  it("refuses when the network now needs a larger resource fee than declared", async () => {
    const w = setup();
    w.submitter.simulateResult = { ok: true, minResourceFee: "500000" };
    const inner = await innerTx(w.buyer, [fundEscrow(w.escrow, w.buyer.publicKey())], { resourceFee: 200_000 });
    expect(await w.service.bumpAndSubmit(inner)).toMatchObject({ ok: false, reason: "resource-fee-stale" });
  });

  it("rate-limits per wallet", async () => {
    const clock = new ManualClock(0);
    const w = setup({ rateLimiter: new FixedWindowRateLimiter(1, 60_000, clock) });
    expect((await w.service.bumpAndSubmit(await rampPay(w))).ok).toBe(true);
    expect(await w.service.bumpAndSubmit(await rampPay(w))).toMatchObject({ ok: false, reason: "rate-limited" });
    clock.advance(60_000);
    expect((await w.service.bumpAndSubmit(await rampPay(w))).ok).toBe(true);
  });

  it("refuses a fee-bump whose total fee exceeds the cap", async () => {
    const w = setup({ feeBumpCap: 150n });
    expect(await w.service.bumpAndSubmit(await rampPay(w))).toMatchObject({ ok: false, reason: "fee-bump-above-cap" });
    expect(w.submitter.submitted).toHaveLength(0);
  });

  it("co-signs the inner sponsored-trustline sandwich as its Begin source", async () => {
    const w = setup();
    const inner = buildUserSourcedSponsoredTrustlineTx(new Account(w.buyer.publicKey(), "1"), w.sponsor.publicKey(), w.xeur, {
      networkPassphrase: NP,
    });
    await attachSignature(inner, w.buyer);
    const r = await w.service.bumpAndSubmit(inner);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(hasValidSignatureFrom(r.feeBump.innerTransaction, w.buyer.publicKey())).toBe(true);
    expect(hasValidSignatureFrom(r.feeBump.innerTransaction, w.sponsor.publicKey())).toBe(true);
  });

  it("returns the submitter's error without throwing", async () => {
    const w = setup();
    w.submitter.submitError = "tx_bad_seq";
    const r = await w.service.bumpAndSubmit(await rampPay(w));
    expect(r).toMatchObject({ ok: true, outcome: { ok: false, error: "tx_bad_seq" } });
  });

  it("refuses a sponsor signer that does not match the policy", () => {
    const w = world();
    expect(
      () =>
        new FeeBumpService({
          policy: w.policy(),
          sponsor: KeypairSigner.random(),
          submitter: new InMemorySubmitter(NP),
          rateLimiter: unlimited,
        }),
    ).toThrow(/sponsor/);
  });

  it("refuses to run against the public network", () => {
    const w = world();
    expect(
      () =>
        new FeeBumpService({
          policy: w.policy({ networkPassphrase: Networks.PUBLIC }),
          sponsor: w.sponsor,
          submitter: new InMemorySubmitter(Networks.PUBLIC),
          rateLimiter: unlimited,
        }),
    ).toThrow(/testnet-only/);
  });
});
