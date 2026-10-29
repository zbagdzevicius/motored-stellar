import { Keypair } from "@stellar/stellar-sdk";
import { beforeEach, describe, expect, it } from "vitest";
import {
  EURC_UNITS_PER_EUR,
  InMemoryEurcLedger,
  InMemoryRamp,
  RampError,
  assertEscrowReceiver,
  checkOffRampPayment,
  offRampTarget,
  quoteOnRamp,
  type FeeSchedule,
} from "../src/index.js";

const EUR = EURC_UNITS_PER_EUR;
const onFees: FeeSchedule = { percentPpm: 2_500n, fixedCents: 30n };
const offFees: FeeSchedule = { percentPpm: 5_000n, fixedCents: 25n };

const iban = {
  bankName: "Example Bank",
  accountOwnerName: "Seller UAB",
  ownerType: "business" as const,
  businessName: "Seller UAB",
  iban: "LT12 1000 0111 0100 1000",
  bic: "EXAMPLTX",
  ibanCountry: "LTU",
  address: { streetLine1: "Gatve 1", city: "Vilnius", postalCode: "01100", country: "LTU" },
};

describe("InMemoryRamp lifecycle", () => {
  let ledger: InMemoryEurcLedger;
  let ramp: InMemoryRamp;
  let buyer: string;
  let seller: string;

  beforeEach(() => {
    ledger = new InMemoryEurcLedger();
    ramp = new InMemoryRamp({ ledger, onRampFees: onFees, offRampFees: offFees });
    buyer = Keypair.random().publicKey();
    seller = Keypair.random().publicKey();
  });

  it("KYC: not_started -> incomplete -> approved gates the virtual account", async () => {
    const link = await ramp.kycLink({ type: "individual", email: "b@example.com", endorsements: ["sepa"] });
    expect(link.kycStatus).toBe("not_started");
    expect(link.tosStatus).toBe("pending");
    const customerId = link.customerId!;
    ledger.openTrustline(buyer);

    await expect(ramp.createVirtualAccount(customerId, { destinationAddress: buyer })).rejects.toMatchObject({
      code: "KYC_NOT_APPROVED",
    });
    ramp.setKycStatus(customerId, "incomplete");
    await expect(ramp.createVirtualAccount(customerId, { destinationAddress: buyer })).rejects.toThrow(RampError);
    ramp.setKycStatus(customerId, "approved");
    expect((await ramp.getKycLink(link.id)).tosStatus).toBe("approved");
    const va = await ramp.createVirtualAccount(customerId, { destinationAddress: buyer });
    expect(va.status).toBe("activated");
  });

  it("a rejected customer cannot open ramp resources", async () => {
    const c = await ramp.createCustomer({ type: "individual", email: "x@example.com" });
    ramp.setKycStatus(c.id, "rejected");
    ledger.openTrustline(buyer);
    await expect(ramp.createVirtualAccount(c.id, { destinationAddress: buyer })).rejects.toMatchObject({
      code: "KYC_NOT_APPROVED",
    });
  });

  it("on-ramp needs the EURC trustline first", async () => {
    const c = await ramp.createCustomer({ type: "individual", email: "b@example.com" });
    ramp.setKycStatus(c.id, "approved");
    await expect(ramp.createVirtualAccount(c.id, { destinationAddress: buyer })).rejects.toMatchObject({
      code: "TRUSTLINE_MISSING",
    });
  });

  it("deposit: a grossed-up SEPA transfer lands at least the target EURC in the buyer's wallet", async () => {
    const c = await ramp.createCustomer({ type: "individual", email: "b@example.com" });
    ramp.setKycStatus(c.id, "approved");
    ledger.openTrustline(buyer);
    const va = await ramp.createVirtualAccount(c.id, { destinationAddress: buyer });

    const target = 87n * EUR + 4_200_000n; // 87.42 EURC
    const q = quoteOnRamp(target, onFees);
    const t = ramp.simulateSepaDeposit(va.id, q.sepaCents);

    expect(t.state).toBe("payment_processed");
    expect(ledger.balance(buyer)).toBe(q.expectedNetUnits);
    expect(ledger.balance(buyer)).toBeGreaterThanOrEqual(target);
    expect(await ramp.getTransfer(t.id)).toEqual(t);
  });

  it("same idempotency key replays the same virtual account", async () => {
    const c = await ramp.createCustomer({ type: "individual", email: "b@example.com" });
    ramp.setKycStatus(c.id, "approved");
    ledger.openTrustline(buyer);
    const a = await ramp.createVirtualAccount(c.id, { destinationAddress: buyer }, { idempotencyKey: "k1" });
    const b = await ramp.createVirtualAccount(c.id, { destinationAddress: buyer }, { idempotencyKey: "k1" });
    expect(b.id).toBe(a.id);
  });

  async function sellerSetup() {
    const c = await ramp.createCustomer({ type: "business", email: "s@example.com" });
    ramp.setKycStatus(c.id, "approved");
    const ea = await ramp.createExternalAccount(c.id, iban);
    expect(ea.last4).toBe("1000");
    const la = await ramp.createLiquidationAddress(c.id, {
      externalAccountId: ea.id,
      sepaReference: "payout ref 01",
      returnTo: { address: seller, memo: "ret-1" },
    });
    ledger.openTrustline(seller);
    ledger.credit(seller, 100n * EUR);
    return { c, ea, la };
  }

  it("liquidation: memoless payment is routed and paid out by SEPA net of fees", async () => {
    const { ea, la } = await sellerSetup();
    expect(la.memolessAddress?.startsWith("M")).toBe(true);
    expect(la.address).toBe(ramp.omnibusAddress);

    // The escrow can never pay the gateway: the receiver rule rejects both forms.
    expect(() => assertEscrowReceiver(la.memolessAddress!)).toThrow(RampError);
    expect(() => assertEscrowReceiver(la.address, [ramp.omnibusAddress])).toThrow(RampError);

    const target = offRampTarget(la);
    expect(target.kind).toBe("memoless");
    checkOffRampPayment(la, { destination: target.destination });
    const r = ramp.receiveEurcPayment({ from: seller, to: target.destination, units: 100n * EUR });
    expect(r.matched).toBe(true);
    if (!r.matched) return;
    expect(r.payout).toEqual({
      transferId: r.transfer.id,
      externalAccountId: ea.id,
      cents: 9_925n, // 100.00 - (0.50 + 0.25)
      reference: "payout ref 01",
    });
    expect(ledger.balance(seller)).toBe(0n);
    expect((await ramp.getTransfer(r.transfer.id)).state).toBe("payment_processed");
  });

  it("liquidation: address plus memo is routed; a missing memo is held unmatched", async () => {
    const { la } = await sellerSetup();
    const lost = ramp.receiveEurcPayment({ from: seller, to: la.address, units: 10n * EUR });
    expect(lost.matched).toBe(false);
    const ok = ramp.receiveEurcPayment({ from: seller, to: la.address, memo: la.memo!, units: 10n * EUR });
    expect(ok.matched).toBe(true);
    expect(ramp.payouts).toHaveLength(1);
  });

  it("returned SEPA payout sends EURC back to the return instructions", async () => {
    const { la } = await sellerSetup();
    const r = ramp.receiveEurcPayment({ from: seller, to: la.memolessAddress!, units: 40n * EUR });
    if (!r.matched) throw new Error("expected a match");
    expect(ledger.balance(seller)).toBe(60n * EUR);
    const ret = ramp.simulatePayoutReturn(r.transfer.id);
    expect(ret).toEqual({ returnedTo: seller, memo: "ret-1", units: 40n * EUR });
    expect(ledger.balance(seller)).toBe(100n * EUR);
    expect((await ramp.getTransfer(r.transfer.id)).state).toBe("returned");
    expect(() => ramp.simulatePayoutReturn(r.transfer.id)).toThrow(/returned/);
  });

  it("refuses a duplicate liquidation address for the same destination", async () => {
    const { c, ea } = await sellerSetup();
    await expect(
      ramp.createLiquidationAddress(c.id, { externalAccountId: ea.id, returnTo: { address: seller, memo: "r" } }),
    ).rejects.toThrow(/duplicate/);
  });

  it("refuses a muxed return address", async () => {
    const c = await ramp.createCustomer({ type: "business", email: "s@example.com" });
    ramp.setKycStatus(c.id, "approved");
    const ea = await ramp.createExternalAccount(c.id, iban);
    const la = await ramp.createLiquidationAddress(c.id, {
      externalAccountId: ea.id,
      returnTo: { address: seller, memo: "r" },
    });
    await expect(
      ramp.createLiquidationAddress(c.id, {
        externalAccountId: ea.id,
        returnTo: { address: la.memolessAddress!, memo: "r" },
      }),
    ).rejects.toMatchObject({ code: "RECEIVER_NOT_PLAIN_ACCOUNT" });
  });
});
