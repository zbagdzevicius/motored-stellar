import { Networks, TimeoutInfinite, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { buildUserSourcedSponsoredTrustlineTx, attachSignature, eurcTestnet } from "../src/index.js";
import {
  Account,
  Asset,
  Keypair,
  Memo,
  Operation,
  addr,
  addressAuth,
  call,
  fundEscrow,
  i128,
  innerTx,
  u32,
  world,
  NP,
} from "./fixtures.js";

const SOROBAN = { resourceFee: 200_000 };

describe("fee-bump policy: allowed shapes", () => {
  it("fund_escrow on the source's own escrow", async () => {
    const w = world();
    const tx = await innerTx(w.buyer, [fundEscrow(w.escrow, w.buyer.publicKey())], SOROBAN);
    const d = await w.policy().evaluate(tx);
    expect(d).toMatchObject({ allowed: true, soroban: true, action: { kind: "fund_escrow", escrow: w.escrow } });
  });

  it("approve_milestone(index, approver = source)", async () => {
    const w = world();
    const tx = await innerTx(w.buyer, [call(w.escrow, "approve_milestone", [u32(0), addr(w.buyer.publicKey())])], SOROBAN);
    expect(await w.policy().evaluate(tx)).toMatchObject({
      allowed: true,
      action: { kind: "approve_milestone", milestoneIndex: 0 },
    });
  });

  it("dispute_escrow(signer = source)", async () => {
    const w = world();
    const tx = await innerTx(w.buyer, [call(w.escrow, "dispute_escrow", [addr(w.buyer.publicKey())])], SOROBAN);
    expect(await w.policy().evaluate(tx)).toMatchObject({ allowed: true, action: { kind: "dispute_escrow" } });
  });

  it("guard.contest(own escrow, 32-byte evidence)", async () => {
    const w = world();
    const evidence = xdr.ScVal.scvBytes(Buffer.alloc(32, 0xee));
    const tx = await innerTx(w.buyer, [call(w.guard, "contest", [addr(w.escrow), evidence])], SOROBAN);
    expect(await w.policy().evaluate(tx)).toMatchObject({ allowed: true, action: { kind: "contest", escrow: w.escrow } });
  });

  it("the user-sourced sponsored EURC trustline sandwich", async () => {
    const w = world();
    const tx = buildUserSourcedSponsoredTrustlineTx(new Account(w.buyer.publicKey(), "1"), w.sponsor.publicKey(), w.xeur, {
      networkPassphrase: NP,
    });
    await attachSignature(tx, w.buyer);
    expect(await w.policy().evaluate(tx)).toMatchObject({ allowed: true, soroban: false, action: { kind: "sponsored_trustline" } });
  });

  it("an EURC payment to the source's stored ramp destination", async () => {
    const w = world();
    const tx = await innerTx(w.buyer, [Operation.payment({ destination: w.rampAddress, asset: w.xeur, amount: "10" })]);
    expect(await w.policy().evaluate(tx)).toMatchObject({
      allowed: true,
      action: { kind: "offramp_payment", destination: w.rampAddress, amount: "10.0000000" },
    });
  });

  it("an off-ramp payment with the memo the ramp requires", async () => {
    const w = world();
    w.registry.register(w.buyer.publicKey(), {
      escrows: [w.escrow],
      ramp: { address: w.rampAddress, memo: { type: "text", value: "dep-123" } },
    });
    const pay = Operation.payment({ destination: w.rampAddress, asset: w.xeur, amount: "1" });
    const good = await innerTx(w.buyer, [pay], { memo: Memo.text("dep-123") });
    const wrong = await innerTx(w.buyer, [pay], { memo: Memo.text("dep-999") });
    const none = await innerTx(w.buyer, [pay]);
    expect((await w.policy().evaluate(good)).allowed).toBe(true);
    expect(await w.policy().evaluate(wrong)).toMatchObject({ allowed: false, reason: "memo-mismatch" });
    expect(await w.policy().evaluate(none)).toMatchObject({ allowed: false, reason: "memo-mismatch" });
  });
});

describe("fee-bump policy: rejections", () => {
  const cases: Array<[string, (w: ReturnType<typeof world>) => Promise<unknown>, string]> = [
    [
      "payment to an arbitrary address",
      (w) => innerTx(w.buyer, [Operation.payment({ destination: Keypair.random().publicKey(), asset: w.xeur, amount: "10" })]),
      "destination-not-allowed",
    ],
    [
      "payment of another asset to the ramp",
      (w) => innerTx(w.buyer, [Operation.payment({ destination: w.rampAddress, asset: Asset.native(), amount: "1" })]),
      "wrong-asset",
    ],
    [
      "payment whose operation source is someone else",
      (w) =>
        innerTx(w.buyer, [
          Operation.payment({ destination: w.rampAddress, asset: w.xeur, amount: "1", source: w.stranger.publicKey() }),
        ]),
      "foreign-op-source",
    ],
    ["setOptions", (w) => innerTx(w.buyer, [Operation.setOptions({ homeDomain: "example.org" })]), "operation-not-allowed"],
    [
      "an extra operation",
      (w) =>
        innerTx(w.buyer, [
          Operation.payment({ destination: w.rampAddress, asset: w.xeur, amount: "1" }),
          Operation.payment({ destination: w.rampAddress, asset: w.xeur, amount: "1" }),
        ]),
      "operation-count",
    ],
    [
      "a 3-op tx that is not a sponsorship sandwich",
      (w) =>
        innerTx(w.buyer, [
          Operation.payment({ destination: w.rampAddress, asset: w.xeur, amount: "1" }),
          Operation.payment({ destination: w.rampAddress, asset: w.xeur, amount: "1" }),
          Operation.payment({ destination: w.rampAddress, asset: w.xeur, amount: "1" }),
        ]),
      "operation-count",
    ],
    [
      "a classic inner fee above the per-op cap",
      (w) => innerTx(w.buyer, [Operation.payment({ destination: w.rampAddress, asset: w.xeur, amount: "1" })], { fee: "20000" }),
      "fee-above-cap",
    ],
    [
      "a Soroban inner fee above the cap",
      (w) => innerTx(w.buyer, [fundEscrow(w.escrow, w.buyer.publicKey())], { fee: "20000000", resourceFee: 200_000 }),
      "fee-above-cap",
    ],
    [
      "an unregistered source",
      (w) => innerTx(w.stranger, [Operation.payment({ destination: w.rampAddress, asset: w.xeur, amount: "1" })]),
      "unregistered-source",
    ],
    [
      "fund_escrow on someone else's escrow",
      (w) => innerTx(w.buyer, [fundEscrow(w.otherEscrow, w.buyer.publicKey())], SOROBAN),
      "contract-not-allowed",
    ],
    [
      "a direct SAC transfer",
      (w) =>
        innerTx(
          w.buyer,
          [call(w.xeur.contractId(Networks.TESTNET), "transfer", [addr(w.buyer.publicKey()), addr(w.escrow), i128(10n)])],
          SOROBAN,
        ),
      "contract-not-allowed",
    ],
    [
      "fund_escrow naming another signer",
      (w) => innerTx(w.buyer, [fundEscrow(w.escrow, w.stranger.publicKey())], SOROBAN),
      "bad-arguments",
    ],
    ["fund_escrow with amount 0", (w) => innerTx(w.buyer, [fundEscrow(w.escrow, w.buyer.publicKey(), 0n)], SOROBAN), "bad-arguments"],
    [
      "an escrow function outside the allowlist",
      (w) => innerTx(w.buyer, [call(w.escrow, "release_funds", [addr(w.buyer.publicKey())])], SOROBAN),
      "function-not-allowed",
    ],
    [
      "a guard function other than contest",
      (w) => innerTx(w.buyer, [call(w.guard, "register_escrow", [addr(w.escrow)])], SOROBAN),
      "function-not-allowed",
    ],
    [
      "contest on someone else's escrow",
      (w) => innerTx(w.buyer, [call(w.guard, "contest", [addr(w.otherEscrow), xdr.ScVal.scvBytes(Buffer.alloc(32))])], SOROBAN),
      "not-own-escrow",
    ],
    [
      "contest with short evidence",
      (w) => innerTx(w.buyer, [call(w.guard, "contest", [addr(w.escrow), xdr.ScVal.scvBytes(Buffer.alloc(31))])], SOROBAN),
      "bad-arguments",
    ],
    [
      "a call carrying someone else's address authorisation",
      (w) =>
        innerTx(
          w.buyer,
          [call(w.escrow, "fund_escrow", [addr(w.buyer.publicKey()), xdr.ScVal.scvVoid(), xdr.ScVal.scvVoid()], [addressAuth(w.stranger.publicKey(), w.escrow)])],
          SOROBAN,
        ),
      "foreign-auth",
    ],
    [
      "a tx for another network",
      (w) =>
        innerTx(w.buyer, [Operation.payment({ destination: w.rampAddress, asset: w.xeur, amount: "1" })], {
          passphrase: Networks.FUTURENET,
        }),
      "wrong-network",
    ],
    [
      "a tx with no expiry",
      (w) =>
        innerTx(w.buyer, [Operation.payment({ destination: w.rampAddress, asset: w.xeur, amount: "1" })], {
          timeout: TimeoutInfinite,
        }),
      "unbounded-validity",
    ],
    [
      "a tx valid for an hour",
      (w) => innerTx(w.buyer, [Operation.payment({ destination: w.rampAddress, asset: w.xeur, amount: "1" })], { timeout: 3600 }),
      "unbounded-validity",
    ],
  ];

  for (const [name, build, reason] of cases) {
    it(`rejects ${name}`, async () => {
      const w = world();
      const tx = await build(w);
      expect(await w.policy().evaluate(tx as never)).toMatchObject({ allowed: false, reason });
    });
  }

  it("rejects an inner tx the source did not sign", async () => {
    const w = world();
    const tx = new TransactionBuilder(new Account(w.buyer.publicKey(), "1"), { fee: "100", networkPassphrase: NP })
      .addOperation(Operation.payment({ destination: w.rampAddress, asset: w.xeur, amount: "1" }))
      .setTimeout(60)
      .build();
    await attachSignature(tx, w.stranger);
    expect(await w.policy().evaluate(tx)).toMatchObject({ allowed: false, reason: "missing-source-signature" });
  });

  it("rejects a nested fee-bump", async () => {
    const w = world();
    const inner = await innerTx(w.buyer, [Operation.payment({ destination: w.rampAddress, asset: w.xeur, amount: "1" })]);
    const fb = TransactionBuilder.buildFeeBumpTransaction(w.sponsor.publicKey(), "200", inner, NP);
    expect(await w.policy().evaluate(fb)).toMatchObject({ allowed: false, reason: "nested-fee-bump" });
  });

  it("rejects a sponsored trustline for another asset", async () => {
    const w = world();
    const tx = buildUserSourcedSponsoredTrustlineTx(new Account(w.buyer.publicKey(), "1"), w.sponsor.publicKey(), eurcTestnet(), {
      networkPassphrase: NP,
    });
    await attachSignature(tx, w.buyer);
    expect(await w.policy().evaluate(tx)).toMatchObject({ allowed: false, reason: "wrong-asset" });
  });

  it("rejects a sandwich sponsored by someone other than the sponsor", async () => {
    const w = world();
    const tx = buildUserSourcedSponsoredTrustlineTx(new Account(w.buyer.publicKey(), "1"), w.stranger.publicKey(), w.xeur, {
      networkPassphrase: NP,
    });
    await attachSignature(tx, w.buyer);
    expect(await w.policy().evaluate(tx)).toMatchObject({ allowed: false, reason: "bad-arguments" });
  });

  it("rejects a sandwich with a non-default trust limit", async () => {
    const w = world();
    const b = new TransactionBuilder(new Account(w.buyer.publicKey(), "1"), { fee: "100", networkPassphrase: NP })
      .addOperation(Operation.beginSponsoringFutureReserves({ sponsoredId: w.buyer.publicKey(), source: w.sponsor.publicKey() }))
      .addOperation(Operation.changeTrust({ asset: w.xeur, limit: "5" }))
      .addOperation(Operation.endSponsoringFutureReserves({}))
      .setTimeout(60)
      .build();
    await attachSignature(b, w.buyer);
    expect(await w.policy().evaluate(b)).toMatchObject({ allowed: false, reason: "bad-arguments" });
  });
});
