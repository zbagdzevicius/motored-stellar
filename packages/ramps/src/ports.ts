/**
 * Ports for the ramp component.
 *
 * `RampProvider` is the seam between a marketplace and a regulated fiat
 * gateway. It speaks in provider-neutral, camelCase domain types; the Bridge
 * adapter maps them to Bridge's snake_case wire format, and `InMemoryRamp`
 * implements them without any network for tests and the example.
 *
 * Nothing here knows about a particular marketplace. The platform supplies
 * customer emails, G-addresses and SEPA references; this package never stores
 * them beyond the call.
 */

import type { TravelRuleData } from "./travel-rule.js";

// ---------------------------------------------------------------------------
// Infrastructure ports
// ---------------------------------------------------------------------------

/** Minimal response shape this package reads. The global `fetch` Response satisfies it. */
export interface HttpResponse {
  readonly status: number;
  readonly ok: boolean;
  text(): Promise<string>;
}

/** Injectable HTTP client. The global `fetch` satisfies this signature. */
export type HttpClient = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<HttpResponse>;

/** Source of idempotency keys. Defaults to `crypto.randomUUID`. */
export type IdempotencyKeyFactory = () => string;

/** Wall clock, injectable so Travel Rule attestation checks are testable. */
export interface Clock {
  now(): Date;
}

/** System clock. */
export const systemClock: Clock = { now: () => new Date() };

/**
 * Answers whether a Stellar account holds an EURC trustline. A virtual account
 * must only be created after the destination wallet can receive EURC, or the
 * gateway's delivery fails.
 */
export interface TrustlineGate {
  hasEurcTrustline(account: string): Promise<boolean>;
}

/** Per-call options shared by every mutating RampProvider method. */
export interface CallOptions {
  /**
   * Idempotency key for this request. Pass a stable value (for example derived
   * from your own order reference) so a retried call cannot create a second
   * resource. When omitted a random key is generated per call.
   */
  idempotencyKey?: string;
}

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export type CustomerType = "individual" | "business";

/**
 * KYC/KYB status values. Taken from Bridge's KycStatus enum; `active` also
 * appears in Bridge's status-transition guide for the customer object.
 */
export type KycStatus =
  | "not_started"
  | "incomplete"
  | "awaiting_questionnaire"
  | "awaiting_ubo"
  | "under_review"
  | "approved"
  | "active"
  | "rejected"
  | "paused"
  | "offboarded"
  | "deposits_restricted";

/** True when a customer may transact. */
export function isKycApproved(status: KycStatus): boolean {
  return status === "approved" || status === "active";
}

/** Endorsement types a hosted KYC flow can request. `sepa` is the one EUR needs. */
export type Endorsement =
  | "base"
  | "cards"
  | "cop"
  | "faster_payments"
  | "pix"
  | "pix_onramp"
  | "pix_offramp"
  | "sepa"
  | "spei";

export interface CreateCustomerInput {
  type: CustomerType;
  email: string;
  firstName?: string;
  lastName?: string;
  /**
   * Further customer fields required by the gateway's customer API (address,
   * birth date, identifying information, signed agreement id, ...). Passed
   * through verbatim. Prefer `kycLink` so this data is entered on the
   * gateway's hosted page and never touches the platform.
   */
  extra?: Record<string, unknown>;
}

export interface RampCustomer {
  id: string;
  type: CustomerType;
  kycStatus: KycStatus;
}

export interface KycLinkInput {
  type: CustomerType;
  email: string;
  /** Person's full name, or a business's full legal name. */
  fullName?: string;
  /** Endorsements to request. EUR on-ramp and off-ramp need `sepa`. */
  endorsements?: Endorsement[];
  /** Where the hosted flow sends the customer when done (http or https). */
  redirectUri?: string;
}

export interface KycLink {
  id: string;
  type: CustomerType;
  /** Present once the gateway has created the customer behind the link. */
  customerId?: string;
  kycUrl: string;
  tosUrl: string;
  kycStatus: KycStatus;
  tosStatus: "pending" | "approved";
}

/** A SEPA bank account (IBAN) the seller is paid out to. */
export interface SepaBankAccountInput {
  bankName: string;
  accountOwnerName: string;
  ownerType: CustomerType;
  firstName?: string;
  lastName?: string;
  businessName?: string;
  iban: string;
  bic: string;
  /** ISO 3166-1 alpha-3 country of the IBAN, e.g. "LTU". */
  ibanCountry: string;
  address: {
    streetLine1: string;
    streetLine2?: string;
    city: string;
    postalCode: string;
    /** ISO 3166-1 alpha-3. */
    country: string;
    state?: string;
  };
}

export interface ExternalAccount {
  id: string;
  customerId: string;
  currency: "eur";
  /** Last four characters of the IBAN as echoed by the gateway. */
  last4?: string;
}

/** Buyer on-ramp: SEPA in, EURC on Stellar out to the buyer's own wallet. */
export interface OnRampInput {
  /** The buyer's own Stellar account (plain G-address with an EURC trustline). */
  destinationAddress: string;
  /** Optional Stellar memo forwarded on delivery. A self-owned wallet needs none. */
  destinationMemo?: string;
  /** Developer fee percent as a base-100 decimal string, e.g. "0.0". */
  developerFeePercent?: string;
  travelRule?: TravelRuleData;
}

/** SEPA deposit instructions the buyer pays to. */
export interface SepaDepositInstructions {
  iban: string;
  bic: string;
  accountHolderName: string;
  bankName?: string;
  bankAddress?: string;
}

export interface VirtualAccount {
  id: string;
  customerId: string;
  status: "activated" | "deactivated";
  deposit: SepaDepositInstructions;
  destination: { address: string; memo?: string; currency: "eurc"; rail: "stellar" };
}

/** Seller off-ramp: EURC on Stellar in, SEPA out to the seller's bank. */
export interface OffRampInput {
  externalAccountId: string;
  /**
   * SEPA remittance reference shown on the seller's bank statement.
   * 6 to 140 characters of a-z A-Z 0-9 space & - . /
   */
  sepaReference?: string;
  /**
   * Where the gateway returns EURC when the SEPA payout fails or is returned.
   * On Stellar both the address and a memo are required.
   */
  returnTo: { address: string; memo: string };
  /** Developer fee percent override for this address (base-100 decimal string). */
  developerFeePercent?: string;
  travelRule?: TravelRuleData;
}

export interface LiquidationAddress {
  id: string;
  customerId: string;
  /** Gateway's Stellar deposit account. Funds sent here MUST carry `memo`. */
  address: string;
  /** Memo that routes a deposit at `address` to this liquidation address. */
  memo?: string;
  /**
   * Muxed (M-) address encoding the routing memo, so the sender needs no
   * separate memo. Preferred when present.
   */
  memolessAddress?: string;
  state: "active" | "deactivated";
  returnMemo?: string;
}

/** Transfer states as documented for Bridge's transfer object. */
export type TransferState =
  | "awaiting_funds"
  | "in_review"
  | "funds_received"
  | "payment_submitted"
  | "payment_processed"
  | "canceled"
  | "undeliverable"
  | "returned"
  | "refund_in_flight"
  | "refund_failed"
  | "refunded";

/** Terminal success state. */
export const TRANSFER_DONE: TransferState = "payment_processed";

export interface Transfer {
  id: string;
  state: TransferState;
  /** Amount as reported by the gateway (decimal string, currency below). */
  amount?: string;
  currency?: string;
  /** On-chain hash of the destination payment, once known. */
  destinationTxHash?: string;
  createdAt?: string;
  updatedAt?: string;
}

// ---------------------------------------------------------------------------
// The port
// ---------------------------------------------------------------------------

/**
 * A regulated SEPA <-> EURC-on-Stellar gateway.
 *
 * Flow for a buyer: `kycLink` -> customer completes the hosted flow ->
 * wallet trustline exists -> `createVirtualAccount` -> buyer sends SEPA to the
 * returned IBAN -> EURC lands in the buyer's wallet -> buyer funds the escrow.
 *
 * Flow for a seller: `kycLink` (KYC or KYB) -> `createExternalAccount` (IBAN)
 * -> `createLiquidationAddress` -> seller sends a classic EURC payment from
 * their own wallet to the liquidation address -> SEPA to the seller's bank.
 */
export interface RampProvider {
  createCustomer(input: CreateCustomerInput, opts?: CallOptions): Promise<RampCustomer>;
  getCustomer(customerId: string): Promise<RampCustomer>;
  kycLink(input: KycLinkInput, opts?: CallOptions): Promise<KycLink>;
  getKycLink(kycLinkId: string): Promise<KycLink>;
  createExternalAccount(
    customerId: string,
    input: SepaBankAccountInput,
    opts?: CallOptions,
  ): Promise<ExternalAccount>;
  createVirtualAccount(
    customerId: string,
    input: OnRampInput,
    opts?: CallOptions,
  ): Promise<VirtualAccount>;
  createLiquidationAddress(
    customerId: string,
    input: OffRampInput,
    opts?: CallOptions,
  ): Promise<LiquidationAddress>;
  getTransfer(transferId: string): Promise<Transfer>;
}
