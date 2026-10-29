/**
 * Bridge wire types (snake_case), limited to the fields this package sends or
 * reads. Field names are taken from Bridge's published API reference and
 * guides (apidocs.bridge.xyz): KYC links, customers, external accounts,
 * virtual accounts, liquidation addresses, transfers and the sandbox guide.
 * Fields the saved docs did not show are marked TODO(verify, D5) where read (D5: Bridge sandbox run).
 */

import type { TravelRuleWire } from "../travel-rule.js";

export interface WireKycLinkRequest {
  full_name?: string;
  email: string;
  type: "individual" | "business";
  endorsements?: string[];
  redirect_uri?: string;
}

export interface WireKycLink {
  id: string;
  type: "individual" | "business";
  customer_id?: string;
  full_name?: string;
  email?: string;
  kyc_link: string;
  tos_link: string;
  kyc_status: string;
  tos_status: string;
  created_at?: string;
}

export interface WireCustomer {
  id: string;
  type?: "individual" | "business";
  /** TODO(verify, D5): customer objects in the guides show `status`; KYC links show `kyc_status`. Both are read. */
  status?: string;
  kyc_status?: string;
}

export interface WireExternalAccountRequest {
  currency: "eur";
  account_type: "iban";
  bank_name: string;
  account_owner_name: string;
  account_owner_type: "individual" | "business";
  first_name?: string;
  last_name?: string;
  business_name?: string;
  iban: { account_number: string; bic: string; country: string };
  address: {
    street_line_1: string;
    street_line_2?: string;
    city: string;
    postal_code: string;
    country: string;
    state?: string;
  };
}

export interface WireExternalAccount {
  id: string;
  customer_id: string;
  currency: string;
  iban?: { last_4?: string };
  last_4?: string;
}

export interface WireVirtualAccountRequest {
  developer_fee_percent?: string;
  source: { currency: "eur" };
  destination: {
    currency: "eurc";
    payment_rail: "stellar";
    address: string;
    blockchain_memo?: string;
  };
  travel_rule_data?: TravelRuleWire;
}

export interface WireVirtualAccount {
  id: string;
  status: "activated" | "deactivated";
  customer_id: string;
  developer_fee_percent?: string;
  source_deposit_instructions: {
    currency?: string;
    iban?: string;
    bic?: string;
    account_holder_name?: string;
    bank_name?: string;
    bank_address?: string;
    payment_rails?: string[];
  };
  destination: {
    currency: string;
    payment_rail: string;
    address?: string;
    blockchain_memo?: string;
  };
}

export interface WireLiquidationAddressRequest {
  chain: "stellar";
  currency: "eurc";
  external_account_id: string;
  destination_payment_rail: "sepa";
  destination_currency: "eur";
  destination_sepa_reference?: string;
  return_instructions: { address: string; memo: string };
  custom_developer_fee_percent?: string;
  travel_rule_data?: TravelRuleWire;
}

export interface WireLiquidationAddress {
  id: string;
  chain: string;
  currency: string;
  customer_id?: string;
  external_account_id?: string;
  address: string;
  blockchain_memo?: string;
  memoless_address?: string;
  destination_payment_rail?: string;
  destination_currency?: string;
  destination_sepa_reference?: string;
  state?: "active" | "deactivated";
  return_memo?: string | null;
}

export interface WireTransfer {
  id: string;
  state: string;
  amount?: string;
  currency?: string;
  /** TODO(verify, D5): location of the destination tx hash on the transfer object (assumed under `receipt`). */
  receipt?: { destination_tx_hash?: string };
  created_at?: string;
  updated_at?: string;
}
