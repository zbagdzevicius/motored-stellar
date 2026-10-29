import { describe, expect, it } from "vitest";
import {
  RampError,
  selfOffRampTravelRule,
  travelRuleToWire,
  validateTravelRule,
} from "../src/index.js";

const clock = { now: () => new Date("2026-10-01T00:00:00Z") };

describe("Travel Rule payload", () => {
  it("requires a name when the party is not the customer", () => {
    expect(() => validateTravelRule({ originator: { isSelf: false } }, clock)).toThrow(RampError);
    expect(() => validateTravelRule({ originator: { isSelf: false, name: "Jane Smith" } }, clock)).not.toThrow();
  });

  it("requires a past attestation time for hosted and self-custodied wallets", () => {
    expect(() =>
      validateTravelRule({ beneficiary: { isSelf: true, walletType: "self_custodied" } }, clock),
    ).toThrow(/wallet_attested_ownership_at is required/);
    expect(() =>
      validateTravelRule(
        { beneficiary: { isSelf: true, walletType: "hosted", walletAttestedOwnershipAt: clock.now() } },
        clock,
      ),
    ).toThrow(/in the past/);
    // An external wallet needs no attestation.
    expect(() => validateTravelRule({ beneficiary: { isSelf: true, walletType: "external" } }, clock)).not.toThrow();
  });

  it("requires ISO alpha-3 countries", () => {
    expect(() =>
      validateTravelRule({ originator: { name: "X", address: { country: "LT" } } }, clock),
    ).toThrow(/alpha-3/);
  });

  it("maps to the documented snake_case shape", () => {
    const wire = travelRuleToWire({
      originator: {
        name: "Jane Smith",
        address: { streetLine1: "123 Market St", city: "Vilnius", postalCode: "01100", country: "LTU" },
        walletType: "self_custodied",
        walletAttestedOwnershipAt: new Date("2026-04-01T12:00:00.000Z"),
      },
      beneficiary: { isSelf: true, walletType: "external" },
    });
    expect(wire).toEqual({
      originator: {
        name: "Jane Smith",
        address: { street_line_1: "123 Market St", city: "Vilnius", postal_code: "01100", country: "LTU" },
        wallet_type: "self_custodied",
        wallet_attested_ownership_at: "2026-04-01T12:00:00Z",
      },
      beneficiary: { is_self: true, wallet_type: "external" },
    });
  });

  it("seller off-ramp preset carries an LEI for business sellers", () => {
    const tr = selfOffRampTravelRule({
      sellerWalletType: "hosted",
      walletAttestedOwnershipAt: new Date("2026-09-01T00:00:00Z"),
      legalEntityIdentifier: "LT100000000000",
    });
    validateTravelRule(tr, clock);
    expect(travelRuleToWire(tr).originator).toMatchObject({ is_self: true, legal_entity_identifier: "LT100000000000" });
  });
});
