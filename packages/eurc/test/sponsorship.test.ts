import { Account, Asset, Keypair, Networks, type Operation, type OperationRecord } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import {
  KeypairSigner,
  attachSignatures,
  buildSponsoredAccountTx,
  buildSponsoredTrustlineTx,
  buildUserSourcedSponsoredTrustlineTx,
  eurcTestnet,
  hasValidSignatureFrom,
  sponsoredReserveStroops,
} from "../src/index.js";

const NP = Networks.TESTNET;

describe("sponsored account creation (CAP-33)", () => {
  const sponsor = KeypairSigner.random();
  const user = KeypairSigner.random();
  const xeur = new Asset("XEUR", Keypair.random().publicKey());

  it("builds Begin / createAccount(0) / ChangeTrust x N / End with the right sources", async () => {
    const tx = buildSponsoredAccountTx(new Account(sponsor.publicKey(), "1"), user.publicKey(), [eurcTestnet(), xeur], {
      networkPassphrase: NP,
    });
    expect(tx.source).toBe(sponsor.publicKey());
    const ops = tx.operations as OperationRecord[];
    expect(ops.map((o) => o.type)).toEqual([
      "beginSponsoringFutureReserves",
      "createAccount",
      "changeTrust",
      "changeTrust",
      "endSponsoringFutureReserves",
    ]);
    const [begin, create, t1, t2, end] = ops as [
      Operation.BeginSponsoringFutureReserves,
      Operation.CreateAccount,
      Operation.ChangeTrust,
      Operation.ChangeTrust,
      Operation.EndSponsoringFutureReserves,
    ];
    // Begin is the sponsor's (it inherits the tx source); it names the user.
    expect(begin.source).toBeUndefined();
    expect(begin.sponsoredId).toBe(user.publicKey());
    expect(create.destination).toBe(user.publicKey());
    expect(Number(create.startingBalance)).toBe(0);
    // ChangeTrust and End are the user's: this is why the user must co-sign.
    expect(t1.source).toBe(user.publicKey());
    expect(t2.source).toBe(user.publicKey());
    expect((t1.line as Asset).equals(eurcTestnet())).toBe(true);
    expect((t2.line as Asset).equals(xeur)).toBe(true);
    expect(end.source).toBe(user.publicKey());
  });

  it("carries valid signatures from both the sponsor and the user", async () => {
    const tx = buildSponsoredAccountTx(new Account(sponsor.publicKey(), "1"), user.publicKey(), [xeur], {
      networkPassphrase: NP,
    });
    await attachSignatures(tx, [sponsor, user]);
    expect(tx.signatures).toHaveLength(2);
    expect(hasValidSignatureFrom(tx, sponsor.publicKey())).toBe(true);
    expect(hasValidSignatureFrom(tx, user.publicKey())).toBe(true);
    expect(hasValidSignatureFrom(tx, Keypair.random().publicKey())).toBe(false);
  });

  it("budgets 1.5 XLM of locked reserve for an account plus one trustline", () => {
    expect(sponsoredReserveStroops(1)).toBe(15_000_000n);
  });
});

describe("sponsored trustline for an existing account", () => {
  const sponsor = KeypairSigner.random();
  const user = KeypairSigner.random();

  it("sponsor-sourced: Begin(user) / ChangeTrust(user) / End(user)", () => {
    const tx = buildSponsoredTrustlineTx(new Account(sponsor.publicKey(), "1"), user.publicKey(), eurcTestnet(), {
      networkPassphrase: NP,
    });
    const [begin, trust, end] = tx.operations as [
      Operation.BeginSponsoringFutureReserves,
      Operation.ChangeTrust,
      Operation.EndSponsoringFutureReserves,
    ];
    expect(tx.source).toBe(sponsor.publicKey());
    expect(begin.sponsoredId).toBe(user.publicKey());
    expect(trust.source).toBe(user.publicKey());
    expect(end.source).toBe(user.publicKey());
  });

  it("user-sourced: Begin names the sponsor as its source", () => {
    const tx = buildUserSourcedSponsoredTrustlineTx(new Account(user.publicKey(), "1"), sponsor.publicKey(), eurcTestnet(), {
      networkPassphrase: NP,
    });
    const [begin, trust, end] = tx.operations as [
      Operation.BeginSponsoringFutureReserves,
      Operation.ChangeTrust,
      Operation.EndSponsoringFutureReserves,
    ];
    expect(tx.source).toBe(user.publicKey());
    expect(begin.source).toBe(sponsor.publicKey());
    expect(begin.sponsoredId).toBe(user.publicKey());
    expect(trust.source).toBeUndefined();
    expect(end.source).toBeUndefined();
  });
});
