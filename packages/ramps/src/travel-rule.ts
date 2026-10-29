/**
 * EU Travel Rule data for crypto movements through the ramp.
 *
 * Any movement through an EEA-regulated gateway that has a EUR or EURC leg is
 * in scope with no threshold. The gateway accepts one payload shape, either
 * attached to a reusable resource (virtual account, liquidation address) when
 * the counterparty is the same for every future movement, or submitted later
 * for one specific movement.
 *
 * In the marketplace flow both resources are personal: a buyer's virtual
 * account delivers to the buyer's own wallet, and a seller's liquidation
 * address is fed from the seller's own wallet. So both parties are `is_self`
 * and the payload can be attached once at creation.
 *
 * For `self_custodied` and `hosted` wallets the platform must verify wallet
 * ownership first (for example by having the wallet sign a challenge) and send
 * the time of that check as `walletAttestedOwnershipAt`, which must be in the
 * past.
 */

import { RampError } from "./errors.js";
import type { Clock } from "./ports.js";
import { systemClock } from "./ports.js";

export type WalletType = "hosted" | "external" | "self_custodied";

export interface TravelRuleAddress {
  streetLine1?: string;
  streetLine2?: string;
  city?: string;
  /** ISO 3166-2 subdivision code. */
  state?: string;
  postalCode?: string;
  /** ISO 3166-1 alpha-3. */
  country?: string;
}

export interface TravelRuleParty {
  /** The party is the gateway customer on the resource; name and address come from the KYC record. */
  isSelf?: boolean;
  /** Legal name. Required when `isSelf` is not true. */
  name?: string;
  address?: TravelRuleAddress;
  walletType?: WalletType;
  /** When wallet ownership was verified. Required for `self_custodied` and `hosted`. */
  walletAttestedOwnershipAt?: Date;
  /** LEI or equivalent (for example a VAT number) when the party is a legal entity. */
  legalEntityIdentifier?: string;
}

export interface TravelRuleData {
  originator?: TravelRuleParty;
  beneficiary?: TravelRuleParty;
}

/** Wire shape (snake_case) as documented for `travel_rule_data`. */
export interface TravelRuleWire {
  originator?: Record<string, unknown>;
  beneficiary?: Record<string, unknown>;
}

/**
 * Validates a Travel Rule payload against the documented rules:
 *   - a party that is not `isSelf` needs a `name`;
 *   - `self_custodied` and `hosted` wallets need `walletAttestedOwnershipAt`;
 *   - that timestamp must be in the past.
 * Throws `RampError("TRAVEL_RULE_INVALID")` on the first violation.
 */
export function validateTravelRule(data: TravelRuleData, clock: Clock = systemClock): void {
  const now = clock.now().getTime();
  for (const role of ["originator", "beneficiary"] as const) {
    const p = data[role];
    if (!p) continue;
    if (!p.isSelf && !p.name) {
      throw new RampError("TRAVEL_RULE_INVALID", `${role}: name is required when is_self is not true`);
    }
    if (p.walletType === "self_custodied" || p.walletType === "hosted") {
      if (!p.walletAttestedOwnershipAt) {
        throw new RampError(
          "TRAVEL_RULE_INVALID",
          `${role}: wallet_attested_ownership_at is required for ${p.walletType} wallets`,
        );
      }
      if (p.walletAttestedOwnershipAt.getTime() >= now) {
        throw new RampError(
          "TRAVEL_RULE_INVALID",
          `${role}: wallet_attested_ownership_at must be in the past`,
        );
      }
    }
    if (p.address?.country !== undefined && p.address.country.length !== 3) {
      throw new RampError("TRAVEL_RULE_INVALID", `${role}: address.country must be ISO alpha-3`);
    }
  }
}

function partyToWire(p: TravelRuleParty): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (p.isSelf !== undefined) out.is_self = p.isSelf;
  if (p.name !== undefined) out.name = p.name;
  if (p.address) {
    const a = p.address;
    const addr: Record<string, unknown> = {};
    if (a.streetLine1 !== undefined) addr.street_line_1 = a.streetLine1;
    if (a.streetLine2 !== undefined) addr.street_line_2 = a.streetLine2;
    if (a.city !== undefined) addr.city = a.city;
    if (a.state !== undefined) addr.state = a.state;
    if (a.postalCode !== undefined) addr.postal_code = a.postalCode;
    if (a.country !== undefined) addr.country = a.country;
    out.address = addr;
  }
  if (p.walletType !== undefined) out.wallet_type = p.walletType;
  if (p.walletAttestedOwnershipAt !== undefined) {
    // ISO 8601 with milliseconds stripped, matching the documented example form.
    out.wallet_attested_ownership_at = p.walletAttestedOwnershipAt
      .toISOString()
      .replace(/\.\d{3}Z$/, "Z");
  }
  if (p.legalEntityIdentifier !== undefined) out.legal_entity_identifier = p.legalEntityIdentifier;
  return out;
}

/** Converts a validated payload to the gateway's snake_case wire shape. */
export function travelRuleToWire(data: TravelRuleData): TravelRuleWire {
  const out: TravelRuleWire = {};
  if (data.originator) out.originator = partyToWire(data.originator);
  if (data.beneficiary) out.beneficiary = partyToWire(data.beneficiary);
  return out;
}

/**
 * Payload for a buyer's on-ramp virtual account: the buyer pays from their own
 * bank account and receives EURC in their own wallet.
 *
 * TODO(verify): which party the gateway expects as originator for a fiat ->
 * crypto virtual-account delivery (Bridge's guide lists virtual accounts as a
 * resource that accepts `travel_rule_data` but shows no on-ramp example). Asked
 * of the gateway; `isSelf` on both sides is the documented shape for a
 * customer moving their own funds.
 */
export function selfOnRampTravelRule(args: {
  buyerWalletType: WalletType;
  walletAttestedOwnershipAt?: Date;
}): TravelRuleData {
  return {
    originator: { isSelf: true },
    beneficiary: {
      isSelf: true,
      walletType: args.buyerWalletType,
      walletAttestedOwnershipAt: args.walletAttestedOwnershipAt,
    },
  };
}

/**
 * Payload for a seller's off-ramp liquidation address: the seller sends EURC
 * from their own wallet and receives euros in their own bank account.
 */
export function selfOffRampTravelRule(args: {
  sellerWalletType: WalletType;
  walletAttestedOwnershipAt?: Date;
  /** Set for business sellers. */
  legalEntityIdentifier?: string;
}): TravelRuleData {
  return {
    originator: {
      isSelf: true,
      walletType: args.sellerWalletType,
      walletAttestedOwnershipAt: args.walletAttestedOwnershipAt,
      legalEntityIdentifier: args.legalEntityIdentifier,
    },
    beneficiary: { isSelf: true, legalEntityIdentifier: args.legalEntityIdentifier },
  };
}
