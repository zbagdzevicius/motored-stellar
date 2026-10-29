import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import {
  BRIDGE_SANDBOX_BASE_URL,
  BridgeApiError,
  BridgeRampProvider,
  BridgeSandbox,
  RampError,
  selfOffRampTravelRule,
  selfOnRampTravelRule,
} from "../src/index.js";
import { FAKE_SANDBOX_KEY, mockHttp } from "./helpers.js";

const fixedClock = { now: () => new Date("2026-10-01T12:00:00Z") };
const g = () => Keypair.random().publicKey();

function provider(responses: Array<{ status?: number; body?: unknown }>, extra = {}) {
  const { http, calls } = mockHttp(responses);
  let n = 0;
  const p = new BridgeRampProvider({
    apiKey: FAKE_SANDBOX_KEY,
    http,
    idempotencyKey: () => `idem-${++n}`,
    clock: fixedClock,
    ...extra,
  });
  return { p, calls };
}

describe("BridgeRampProvider configuration", () => {
  it("defaults to the sandbox base URL", () => {
    const { p } = provider([]);
    expect(p.endpoint).toEqual({ environment: "sandbox", baseUrl: BRIDGE_SANDBOX_BASE_URL });
    expect(BRIDGE_SANDBOX_BASE_URL).toBe("https://api.sandbox.bridge.xyz/v0");
  });

  it("refuses a non sk-test key on the sandbox", () => {
    expect(() => new BridgeRampProvider({ apiKey: "sk-live-x", http: mockHttp().http })).toThrow(RampError);
  });

  it("refuses production unless explicitly allowed", () => {
    expect(
      () => new BridgeRampProvider({ apiKey: "k", environment: "production", http: mockHttp().http }),
    ).toThrow(/allowProduction/);
  });

  it("never puts the API key in an error message", async () => {
    const { p } = provider([{ status: 401, body: { code: "required", message: "missing key" } }]);
    const err = await p.getTransfer("tr_1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BridgeApiError);
    expect((err as BridgeApiError).status).toBe(401);
    expect((err as BridgeApiError).code).toBe("required");
    expect(String((err as Error).message)).not.toContain(FAKE_SANDBOX_KEY);
  });
});

describe("BridgeRampProvider requests", () => {
  it("kycLink: POST /kyc_links with Api-Key, Idempotency-Key and the documented body", async () => {
    const { p, calls } = provider([
      {
        body: {
          id: "kyc_link_123",
          email: "buyer@example.com",
          type: "individual",
          kyc_link: "https://kyc.example/abc",
          tos_link: "https://tos.example/abc",
          kyc_status: "not_started",
          tos_status: "pending",
          customer_id: "cust_123",
        },
      },
    ]);
    const link = await p.kycLink({
      type: "individual",
      email: "buyer@example.com",
      fullName: "Ada Lovelace",
      endorsements: ["sepa"],
      redirectUri: "https://example.com/done",
    });
    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.method).toBe("POST");
    expect(c.url).toBe(`${BRIDGE_SANDBOX_BASE_URL}/kyc_links`);
    expect(c.headers["Api-Key"]).toBe(FAKE_SANDBOX_KEY);
    expect(c.headers["Idempotency-Key"]).toBe("idem-1");
    expect(c.headers["Content-Type"]).toBe("application/json");
    expect(c.body).toEqual({
      email: "buyer@example.com",
      type: "individual",
      full_name: "Ada Lovelace",
      endorsements: ["sepa"],
      redirect_uri: "https://example.com/done",
    });
    expect(link).toEqual({
      id: "kyc_link_123",
      type: "individual",
      customerId: "cust_123",
      kycUrl: "https://kyc.example/abc",
      tosUrl: "https://tos.example/abc",
      kycStatus: "not_started",
      tosStatus: "pending",
    });
  });

  it("kycLink: rejects a non-http redirect", async () => {
    const { p, calls } = provider([]);
    await expect(
      p.kycLink({ type: "business", email: "s@example.com", redirectUri: "javascript:alert(1)" }),
    ).rejects.toThrow(RampError);
    expect(calls).toHaveLength(0);
  });

  it("getKycLink: GET without an Idempotency-Key", async () => {
    const { p, calls } = provider([
      {
        body: {
          id: "kl_1",
          type: "business",
          kyc_link: "k",
          tos_link: "t",
          kyc_status: "approved",
          tos_status: "approved",
          customer_id: "cust_9",
        },
      },
    ]);
    const link = await p.getKycLink("kl_1");
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toBe(`${BRIDGE_SANDBOX_BASE_URL}/kyc_links/kl_1`);
    expect(calls[0]!.headers["Idempotency-Key"]).toBeUndefined();
    expect(link.kycStatus).toBe("approved");
  });

  it("createCustomer: POST /customers, caller idempotency key wins", async () => {
    const { p, calls } = provider([{ body: { id: "cust_1", status: "not_started", type: "individual" } }]);
    const c = await p.createCustomer(
      {
        type: "individual",
        email: "jane@example.com",
        firstName: "Jane",
        lastName: "Sandbox",
        extra: { birth_date: "1980-09-10" },
      },
      { idempotencyKey: "order-42-customer" },
    );
    expect(calls[0]!.url).toBe(`${BRIDGE_SANDBOX_BASE_URL}/customers`);
    expect(calls[0]!.headers["Idempotency-Key"]).toBe("order-42-customer");
    expect(calls[0]!.body).toEqual({
      birth_date: "1980-09-10",
      type: "individual",
      email: "jane@example.com",
      first_name: "Jane",
      last_name: "Sandbox",
    });
    expect(c).toEqual({ id: "cust_1", type: "individual", kycStatus: "not_started" });
  });

  it("unknown KYC status never maps to approved", async () => {
    const { p } = provider([{ body: { id: "cust_1", status: "something_new" } }]);
    expect((await p.getCustomer("cust_1")).kycStatus).toBe("not_started");
  });

  it("createExternalAccount: EUR IBAN body as in the SEPA example", async () => {
    const { p, calls } = provider([
      { body: { id: "ea_1", customer_id: "cust_1", currency: "eur", iban: { last_4: "3000" } } },
    ]);
    const ea = await p.createExternalAccount("cust_1", {
      bankName: "Deutsche Bank",
      accountOwnerName: "Ada Lovelace",
      ownerType: "individual",
      firstName: "Ada",
      lastName: "Lovelace",
      iban: "DE89 3704 0044 0532 0130 00",
      bic: "DEUTDEDBFRA",
      ibanCountry: "DEU",
      address: { streetLine1: "Taunusanlage 12", city: "Frankfurt", postalCode: "60325", country: "DEU" },
    });
    expect(calls[0]!.url).toBe(`${BRIDGE_SANDBOX_BASE_URL}/customers/cust_1/external_accounts`);
    expect(calls[0]!.body).toEqual({
      currency: "eur",
      account_type: "iban",
      bank_name: "Deutsche Bank",
      account_owner_name: "Ada Lovelace",
      account_owner_type: "individual",
      first_name: "Ada",
      last_name: "Lovelace",
      iban: { account_number: "DE89370400440532013000", bic: "DEUTDEDBFRA", country: "DEU" },
      address: { street_line_1: "Taunusanlage 12", city: "Frankfurt", postal_code: "60325", country: "DEU" },
    });
    expect(ea).toEqual({ id: "ea_1", customerId: "cust_1", currency: "eur", last4: "3000" });
  });

  it("createVirtualAccount: EUR source, EURC on stellar to the buyer's G-address, Travel Rule attached", async () => {
    const buyer = g();
    const { p, calls } = provider([
      {
        body: {
          id: "va_1",
          status: "activated",
          customer_id: "cust_1",
          source_deposit_instructions: {
            currency: "eur",
            iban: "LU000000000000000000",
            bic: "BCIRLULL",
            account_holder_name: "Gateway entity",
            bank_name: "Example bank",
            payment_rails: ["sepa"],
          },
          destination: { currency: "eurc", payment_rail: "stellar", address: buyer },
        },
      },
    ]);
    const va = await p.createVirtualAccount("cust_1", {
      destinationAddress: buyer,
      developerFeePercent: "0.0",
      travelRule: selfOnRampTravelRule({
        buyerWalletType: "hosted",
        walletAttestedOwnershipAt: new Date("2026-09-30T10:00:00Z"),
      }),
    });
    expect(calls[0]!.url).toBe(`${BRIDGE_SANDBOX_BASE_URL}/customers/cust_1/virtual_accounts`);
    expect(calls[0]!.headers["Idempotency-Key"]).toBe("idem-1");
    expect(calls[0]!.body).toEqual({
      source: { currency: "eur" },
      destination: { currency: "eurc", payment_rail: "stellar", address: buyer },
      developer_fee_percent: "0.0",
      travel_rule_data: {
        originator: { is_self: true },
        beneficiary: {
          is_self: true,
          wallet_type: "hosted",
          wallet_attested_ownership_at: "2026-09-30T10:00:00Z",
        },
      },
    });
    expect(va.deposit).toEqual({
      iban: "LU000000000000000000",
      bic: "BCIRLULL",
      accountHolderName: "Gateway entity",
      bankName: "Example bank",
    });
    expect(va.destination).toEqual({ address: buyer, currency: "eurc", rail: "stellar" });
  });

  it("createVirtualAccount: refuses a wallet without an EURC trustline before calling the API", async () => {
    const { p, calls } = provider([], { trustlineGate: { hasEurcTrustline: async () => false } });
    await expect(p.createVirtualAccount("cust_1", { destinationAddress: g() })).rejects.toMatchObject({
      code: "TRUSTLINE_MISSING",
    });
    expect(calls).toHaveLength(0);
  });

  it("createVirtualAccount: refuses an attestation in the future", async () => {
    const { p, calls } = provider([]);
    await expect(
      p.createVirtualAccount("cust_1", {
        destinationAddress: g(),
        travelRule: selfOnRampTravelRule({
          buyerWalletType: "self_custodied",
          walletAttestedOwnershipAt: new Date("2027-01-01T00:00:00Z"),
        }),
      }),
    ).rejects.toMatchObject({ code: "TRAVEL_RULE_INVALID" });
    expect(calls).toHaveLength(0);
  });

  it("createLiquidationAddress: stellar/eurc -> sepa/eur with return instructions (address + memo)", async () => {
    const seller = g();
    const omnibus = g();
    const { p, calls } = provider([
      {
        status: 201,
        body: {
          id: "la_1",
          chain: "stellar",
          currency: "eurc",
          customer_id: "cust_2",
          external_account_id: "ea_1",
          address: omnibus,
          blockchain_memo: "12345",
          destination_payment_rail: "sepa",
          destination_currency: "eur",
          destination_sepa_reference: "Payout ref 0001",
          state: "active",
          return_memo: "ret-0001",
        },
      },
    ]);
    const la = await p.createLiquidationAddress("cust_2", {
      externalAccountId: "ea_1",
      sepaReference: "Payout ref 0001",
      returnTo: { address: seller, memo: "ret-0001" },
      travelRule: selfOffRampTravelRule({
        sellerWalletType: "hosted",
        walletAttestedOwnershipAt: new Date("2026-09-30T10:00:00Z"),
      }),
    });
    expect(calls[0]!.url).toBe(`${BRIDGE_SANDBOX_BASE_URL}/customers/cust_2/liquidation_addresses`);
    expect(calls[0]!.headers["Idempotency-Key"]).toBe("idem-1");
    expect(calls[0]!.body).toEqual({
      chain: "stellar",
      currency: "eurc",
      external_account_id: "ea_1",
      destination_payment_rail: "sepa",
      destination_currency: "eur",
      destination_sepa_reference: "Payout ref 0001",
      return_instructions: { address: seller, memo: "ret-0001" },
      travel_rule_data: {
        originator: {
          is_self: true,
          wallet_type: "hosted",
          wallet_attested_ownership_at: "2026-09-30T10:00:00Z",
        },
        beneficiary: { is_self: true },
      },
    });
    expect(la).toEqual({
      id: "la_1",
      customerId: "cust_2",
      address: omnibus,
      memo: "12345",
      state: "active",
      returnMemo: "ret-0001",
    });
  });

  it("createLiquidationAddress: refuses a missing return memo and a bad SEPA reference", async () => {
    const { p, calls } = provider([]);
    await expect(
      p.createLiquidationAddress("c", { externalAccountId: "ea", returnTo: { address: g(), memo: "" } }),
    ).rejects.toThrow(/return memo/);
    await expect(
      p.createLiquidationAddress("c", {
        externalAccountId: "ea",
        sepaReference: "bad_ref!",
        returnTo: { address: g(), memo: "m1" },
      }),
    ).rejects.toMatchObject({ code: "SEPA_REFERENCE_INVALID" });
    expect(calls).toHaveLength(0);
  });

  it("createLiquidationAddress: refuses a response with neither memo nor memoless address", async () => {
    const { p } = provider([{ status: 201, body: { id: "la_x", chain: "stellar", currency: "eurc", address: g() } }]);
    await expect(
      p.createLiquidationAddress("c", { externalAccountId: "ea", returnTo: { address: g(), memo: "m" } }),
    ).rejects.toThrow(/without memo/);
  });

  it("getTransfer: GET /transfers/{id}; unknown state is not treated as done", async () => {
    const { p, calls } = provider([
      { body: { id: "tr_1", state: "payment_processed", amount: "98.63", currency: "eurc" } },
      { body: { id: "tr_2", state: "brand_new_state" } },
    ]);
    const t1 = await p.getTransfer("tr_1");
    expect(calls[0]!.url).toBe(`${BRIDGE_SANDBOX_BASE_URL}/transfers/tr_1`);
    expect(t1).toEqual({ id: "tr_1", state: "payment_processed", amount: "98.63", currency: "eurc" });
    expect((await p.getTransfer("tr_2")).state).toBe("in_review");
  });

  it("encodes path segments", async () => {
    const { p, calls } = provider([{ body: { id: "x", state: "awaiting_funds" } }]);
    await p.getTransfer("../customers");
    expect(calls[0]!.url).toBe(`${BRIDGE_SANDBOX_BASE_URL}/transfers/..%2Fcustomers`);
  });
});

describe("BridgeSandbox", () => {
  it("uses the documented simulation paths and bodies", async () => {
    const { p, calls } = provider([
      { body: {} },
      { body: {} },
      { body: { success: true, drain_id: "drain_1" } },
    ]);
    const sb = new BridgeSandbox(p);
    await sb.simulateKycApproval("cust_1");
    await sb.simulateSepaDeposit("cust_1", "va_1", 25_000n);
    const r = await sb.simulateEurcDeposit("cust_2", "la_1", 1_000_000_000n);

    expect(calls[0]!.url).toBe(`${BRIDGE_SANDBOX_BASE_URL}/customers/cust_1/simulate_kyc_approval`);
    expect(calls[0]!.headers["Idempotency-Key"]).toBeDefined();
    expect(calls[1]!.url).toBe(`${BRIDGE_SANDBOX_BASE_URL}/customers/cust_1/virtual_accounts/va_1/simulate_deposit`);
    expect(calls[1]!.body).toEqual({ currency: "eur", amount: "250.00" });
    expect(calls[2]!.url).toBe(
      `${BRIDGE_SANDBOX_BASE_URL}/customers/cust_2/liquidation_addresses/la_1/simulate_deposit`,
    );
    expect(calls[2]!.body).toEqual({ currency: "eurc", amount: "100.0000000" });
    expect(r.drainId).toBe("drain_1");
    expect(r.success).toBe(true);
  });

  it("refuses to run against production", () => {
    const p = new BridgeRampProvider({
      apiKey: "k",
      environment: "production",
      allowProduction: true,
      http: mockHttp().http,
    });
    expect(() => new BridgeSandbox(p)).toThrow(/sandbox/);
  });
});
