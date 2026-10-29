/**
 * `RampProvider` implementation for Bridge (apidocs.bridge.xyz).
 *
 * Endpoints used, all relative to the configured base URL (`.../v0`):
 *
 *   POST /customers                                          createCustomer
 *   GET  /customers/{customerID}                             getCustomer
 *   POST /kyc_links                                          kycLink
 *   GET  /kyc_links/{kycLinkID}                              getKycLink
 *   POST /customers/{customerID}/external_accounts           createExternalAccount (EUR IBAN)
 *   POST /customers/{customerID}/virtual_accounts            createVirtualAccount (EUR -> EURC@stellar)
 *   POST /customers/{customerID}/liquidation_addresses       createLiquidationAddress (EURC@stellar -> SEPA)
 *   GET  /transfers/{transferID}                             getTransfer
 *
 * Local guards run before any request is sent:
 *   - on-ramp destination is a plain G-address and (if a TrustlineGate is
 *     configured) already holds an EURC trustline;
 *   - liquidation return address is a plain G-address with a memo, as Stellar
 *     requires;
 *   - SEPA reference charset and length;
 *   - Travel Rule payload completeness and wallet attestation time.
 *
 * Static memos are not used: Bridge documents them as deprecated and as a
 * wire/ACH (USD) deposit route, so they do not apply to EUR on SEPA.
 */

import { RampError } from "../errors.js";
import type {
  CallOptions,
  Clock,
  CreateCustomerInput,
  CustomerType,
  ExternalAccount,
  KycLink,
  KycLinkInput,
  KycStatus,
  LiquidationAddress,
  OffRampInput,
  OnRampInput,
  RampCustomer,
  RampProvider,
  SepaBankAccountInput,
  Transfer,
  TransferState,
  TrustlineGate,
  VirtualAccount,
} from "../ports.js";
import { systemClock } from "../ports.js";
import { isPlainAccount } from "../receiver.js";
import { assertSepaReference } from "../sepa.js";
import { travelRuleToWire, validateTravelRule } from "../travel-rule.js";
import { BridgeHttp, type BridgeConfig, seg } from "./http.js";
import type {
  WireCustomer,
  WireExternalAccount,
  WireExternalAccountRequest,
  WireKycLink,
  WireKycLinkRequest,
  WireLiquidationAddress,
  WireLiquidationAddressRequest,
  WireTransfer,
  WireVirtualAccount,
  WireVirtualAccountRequest,
} from "./wire.js";

export interface BridgeRampOptions extends BridgeConfig {
  /** When set, `createVirtualAccount` refuses wallets without an EURC trustline. */
  trustlineGate?: TrustlineGate;
  /** Clock for Travel Rule attestation checks. */
  clock?: Clock;
}

const KYC_STATUSES: ReadonlySet<string> = new Set<KycStatus>([
  "not_started",
  "incomplete",
  "awaiting_questionnaire",
  "awaiting_ubo",
  "under_review",
  "approved",
  "active",
  "rejected",
  "paused",
  "offboarded",
  "deposits_restricted",
]);

const TRANSFER_STATES: ReadonlySet<string> = new Set<TransferState>([
  "awaiting_funds",
  "in_review",
  "funds_received",
  "payment_submitted",
  "payment_processed",
  "canceled",
  "undeliverable",
  "returned",
  "refund_in_flight",
  "refund_failed",
  "refunded",
]);

function toKycStatus(raw: string | undefined): KycStatus {
  if (raw && KYC_STATUSES.has(raw)) return raw as KycStatus;
  // Unknown or missing values are treated as not approved, never as approved.
  return "not_started";
}

function toTransferState(raw: string): TransferState {
  if (TRANSFER_STATES.has(raw)) return raw as TransferState;
  // An unknown state is surfaced as review, which no caller treats as done.
  return "in_review";
}

export class BridgeRampProvider implements RampProvider {
  readonly #http: BridgeHttp;
  readonly #trustlines: TrustlineGate | undefined;
  readonly #clock: Clock;

  constructor(options: BridgeRampOptions) {
    this.#http = new BridgeHttp(options);
    this.#trustlines = options.trustlineGate;
    this.#clock = options.clock ?? systemClock;
  }

  /** Environment and base URL in use (no secrets). */
  get endpoint(): { environment: string; baseUrl: string } {
    return { environment: this.#http.environment, baseUrl: this.#http.baseUrl };
  }

  /** Exposes the HTTP layer to the sandbox helpers in this package. */
  get http(): BridgeHttp {
    return this.#http;
  }

  async createCustomer(input: CreateCustomerInput, opts?: CallOptions): Promise<RampCustomer> {
    const body: Record<string, unknown> = {
      ...(input.extra ?? {}),
      type: input.type,
      email: input.email,
    };
    if (input.firstName !== undefined) body.first_name = input.firstName;
    if (input.lastName !== undefined) body.last_name = input.lastName;
    const res = await this.#http.post<WireCustomer>("/customers", body, opts?.idempotencyKey);
    return this.#customer(res, input.type);
  }

  async getCustomer(customerId: string): Promise<RampCustomer> {
    const res = await this.#http.get<WireCustomer>(`/customers/${seg(customerId)}`);
    return this.#customer(res);
  }

  async kycLink(input: KycLinkInput, opts?: CallOptions): Promise<KycLink> {
    if (input.redirectUri !== undefined && !/^https?:\/\//.test(input.redirectUri)) {
      throw new RampError("CONFIG_INVALID", "redirectUri must start with http:// or https://");
    }
    const body: WireKycLinkRequest = { email: input.email, type: input.type };
    if (input.fullName !== undefined) body.full_name = input.fullName;
    if (input.endorsements !== undefined) body.endorsements = [...input.endorsements];
    if (input.redirectUri !== undefined) body.redirect_uri = input.redirectUri;
    const res = await this.#http.post<WireKycLink>("/kyc_links", body, opts?.idempotencyKey);
    return this.#kycLink(res);
  }

  async getKycLink(kycLinkId: string): Promise<KycLink> {
    const res = await this.#http.get<WireKycLink>(`/kyc_links/${seg(kycLinkId)}`);
    return this.#kycLink(res);
  }

  async createExternalAccount(
    customerId: string,
    input: SepaBankAccountInput,
    opts?: CallOptions,
  ): Promise<ExternalAccount> {
    const body: WireExternalAccountRequest = {
      currency: "eur",
      account_type: "iban",
      bank_name: input.bankName,
      account_owner_name: input.accountOwnerName,
      account_owner_type: input.ownerType,
      iban: {
        account_number: input.iban.replace(/\s+/g, ""),
        bic: input.bic,
        country: input.ibanCountry,
      },
      address: {
        street_line_1: input.address.streetLine1,
        city: input.address.city,
        postal_code: input.address.postalCode,
        country: input.address.country,
      },
    };
    if (input.firstName !== undefined) body.first_name = input.firstName;
    if (input.lastName !== undefined) body.last_name = input.lastName;
    // TODO(verify, D5): `business_name` on a business-owned EUR external account
    // (it appears as a response field in the saved docs, not in a request example).
    if (input.businessName !== undefined) body.business_name = input.businessName;
    if (input.address.streetLine2 !== undefined) body.address.street_line_2 = input.address.streetLine2;
    if (input.address.state !== undefined) body.address.state = input.address.state;

    const res = await this.#http.post<WireExternalAccount>(
      `/customers/${seg(customerId)}/external_accounts`,
      body,
      opts?.idempotencyKey,
    );
    const last4 = res.iban?.last_4 ?? res.last_4;
    const out: ExternalAccount = { id: res.id, customerId: res.customer_id ?? customerId, currency: "eur" };
    if (last4 !== undefined) out.last4 = last4;
    return out;
  }

  async createVirtualAccount(
    customerId: string,
    input: OnRampInput,
    opts?: CallOptions,
  ): Promise<VirtualAccount> {
    if (!isPlainAccount(input.destinationAddress)) {
      throw new RampError(
        "RECEIVER_NOT_PLAIN_ACCOUNT",
        "on-ramp destination must be the buyer's own plain G-address",
      );
    }
    if (this.#trustlines && !(await this.#trustlines.hasEurcTrustline(input.destinationAddress))) {
      throw new RampError(
        "TRUSTLINE_MISSING",
        "create the EURC trustline before the virtual account, or deliveries fail",
      );
    }
    const body: WireVirtualAccountRequest = {
      source: { currency: "eur" },
      destination: {
        currency: "eurc",
        payment_rail: "stellar",
        address: input.destinationAddress,
      },
    };
    if (input.developerFeePercent !== undefined) body.developer_fee_percent = input.developerFeePercent;
    if (input.destinationMemo !== undefined) body.destination.blockchain_memo = input.destinationMemo;
    if (input.travelRule) {
      validateTravelRule(input.travelRule, this.#clock);
      body.travel_rule_data = travelRuleToWire(input.travelRule);
    }

    const res = await this.#http.post<WireVirtualAccount>(
      `/customers/${seg(customerId)}/virtual_accounts`,
      body,
      opts?.idempotencyKey,
    );
    const sdi = res.source_deposit_instructions ?? {};
    if (!sdi.iban || !sdi.bic) {
      throw new RampError("INVALID_STATE", "virtual account response has no IBAN/BIC deposit instructions");
    }
    const deposit: VirtualAccount["deposit"] = {
      iban: sdi.iban,
      bic: sdi.bic,
      accountHolderName: sdi.account_holder_name ?? "",
    };
    if (sdi.bank_name !== undefined) deposit.bankName = sdi.bank_name;
    if (sdi.bank_address !== undefined) deposit.bankAddress = sdi.bank_address;
    const destination: VirtualAccount["destination"] = {
      address: res.destination.address ?? input.destinationAddress,
      currency: "eurc",
      rail: "stellar",
    };
    if (res.destination.blockchain_memo) destination.memo = res.destination.blockchain_memo;
    return {
      id: res.id,
      customerId: res.customer_id ?? customerId,
      status: res.status,
      deposit,
      destination,
    };
  }

  async createLiquidationAddress(
    customerId: string,
    input: OffRampInput,
    opts?: CallOptions,
  ): Promise<LiquidationAddress> {
    if (!isPlainAccount(input.returnTo.address)) {
      throw new RampError(
        "RECEIVER_NOT_PLAIN_ACCOUNT",
        "return address must be the seller's own plain G-address",
      );
    }
    if (!input.returnTo.memo) {
      // Documented: for Stellar, return_instructions needs both address and memo.
      throw new RampError("INVALID_STATE", "return memo is required on Stellar");
    }
    if (input.sepaReference !== undefined) assertSepaReference(input.sepaReference);

    const body: WireLiquidationAddressRequest = {
      chain: "stellar",
      currency: "eurc",
      external_account_id: input.externalAccountId,
      destination_payment_rail: "sepa",
      destination_currency: "eur",
      return_instructions: { address: input.returnTo.address, memo: input.returnTo.memo },
    };
    if (input.sepaReference !== undefined) body.destination_sepa_reference = input.sepaReference;
    if (input.developerFeePercent !== undefined) {
      body.custom_developer_fee_percent = input.developerFeePercent;
    }
    if (input.travelRule) {
      validateTravelRule(input.travelRule, this.#clock);
      body.travel_rule_data = travelRuleToWire(input.travelRule);
    }

    const res = await this.#http.post<WireLiquidationAddress>(
      `/customers/${seg(customerId)}/liquidation_addresses`,
      body,
      opts?.idempotencyKey,
    );
    const out: LiquidationAddress = {
      id: res.id,
      customerId: res.customer_id ?? customerId,
      address: res.address,
      state: res.state ?? "active",
    };
    if (res.blockchain_memo) out.memo = res.blockchain_memo;
    if (res.memoless_address) out.memolessAddress = res.memoless_address;
    if (res.return_memo) out.returnMemo = res.return_memo;
    if (!out.memo && !out.memolessAddress) {
      // Without either, a deposit cannot be routed. Refuse to hand it to a seller.
      throw new RampError("INVALID_STATE", "Stellar liquidation address returned without memo or memoless address");
    }
    return out;
  }

  async getTransfer(transferId: string): Promise<Transfer> {
    const res = await this.#http.get<WireTransfer>(`/transfers/${seg(transferId)}`);
    const out: Transfer = { id: res.id, state: toTransferState(res.state) };
    if (res.amount !== undefined) out.amount = res.amount;
    if (res.currency !== undefined) out.currency = res.currency;
    if (res.receipt?.destination_tx_hash) out.destinationTxHash = res.receipt.destination_tx_hash;
    if (res.created_at !== undefined) out.createdAt = res.created_at;
    if (res.updated_at !== undefined) out.updatedAt = res.updated_at;
    return out;
  }

  #customer(res: WireCustomer, fallbackType?: CustomerType): RampCustomer {
    return {
      id: res.id,
      type: res.type ?? fallbackType ?? "individual",
      kycStatus: toKycStatus(res.kyc_status ?? res.status),
    };
  }

  #kycLink(res: WireKycLink): KycLink {
    const out: KycLink = {
      id: res.id,
      type: res.type,
      kycUrl: res.kyc_link,
      tosUrl: res.tos_link,
      kycStatus: toKycStatus(res.kyc_status),
      tosStatus: res.tos_status === "approved" ? "approved" : "pending",
    };
    if (res.customer_id) out.customerId = res.customer_id;
    return out;
  }
}
