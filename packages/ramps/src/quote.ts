/**
 * Ramp fee quotes.
 *
 * On-ramp: the gateway delivers EURC net of its fees, so to land a target
 * EURC amount in the buyer's wallet the buyer must send a SEPA amount grossed
 * up from the fee schedule. Any remaining shortfall or excess is handled
 * before funding the escrow (the buyer tops up, or the excess stays in the
 * buyer's wallet).
 *
 * Off-ramp: the seller is shown the gateway's fee before cashing out.
 *
 * The fee schedule is an INPUT. This module does not claim to know the
 * gateway's prices; the platform loads them from its contract with the
 * gateway. Rates are expressed in parts per million so 0.1% is 1000 ppm and
 * no floating point is involved.
 *
 * TODO(verify, D5): the gateway's exact fee composition and rounding. Its docs
 * list a developer fee and an exchange fee (both in the source currency) and a
 * gas fee (in the destination currency, "usually 0"), and minimum amounts per
 * route. This model rounds every percentage fee UP to the next cent, which is
 * conservative: the real net can only be equal or higher than quoted.
 */

import { EURC_UNITS_PER_CENT, centsToUnits, unitsToCentsCeil, unitsToCentsFloor } from "./amounts.js";

const PPM = 1_000_000n;

export interface FeeSchedule {
  /** Sum of percentage fees (developer + exchange), in parts per million. */
  percentPpm: bigint;
  /** Fixed fee per movement, in cents. */
  fixedCents: bigint;
  /** Gas or network fee deducted from the destination, in EURC base units (on-ramp only). */
  destinationFeeUnits?: bigint;
  /** Minimum source amount the gateway accepts for this route, in cents. */
  minimumCents?: bigint;
}

function assertSchedule(s: FeeSchedule): void {
  if (s.percentPpm < 0n || s.percentPpm >= PPM) throw new RangeError("percentPpm must be in [0, 1e6)");
  if (s.fixedCents < 0n) throw new RangeError("fixedCents must be non-negative");
  if ((s.destinationFeeUnits ?? 0n) < 0n) throw new RangeError("destinationFeeUnits must be non-negative");
  if ((s.minimumCents ?? 0n) < 0n) throw new RangeError("minimumCents must be non-negative");
}

/** Percentage fee on `cents`, rounded up to a whole cent. */
function percentFeeCents(cents: bigint, ppm: bigint): bigint {
  return (cents * ppm + PPM - 1n) / PPM;
}

/** Total source-side fee for an on-ramp of `grossCents`. */
export function onRampFeeCents(grossCents: bigint, schedule: FeeSchedule): bigint {
  assertSchedule(schedule);
  return percentFeeCents(grossCents, schedule.percentPpm) + schedule.fixedCents;
}

/**
 * EURC base units delivered for a SEPA deposit of `grossCents` under the
 * schedule, at face value (1 EUR = 1 EURC). Never negative.
 *
 * TODO(verify, D5): EUR -> EURC is treated as 1:1 at face value with any spread
 * carried in `percentPpm` as the exchange fee.
 */
export function onRampNetUnits(grossCents: bigint, schedule: FeeSchedule): bigint {
  const netCents = grossCents - onRampFeeCents(grossCents, schedule);
  const units = centsToUnits(netCents > 0n ? netCents : 0n) - (schedule.destinationFeeUnits ?? 0n);
  return units > 0n ? units : 0n;
}

export interface OnRampQuote {
  /** SEPA amount the buyer sends, in cents. */
  sepaCents: bigint;
  /** Fee the schedule predicts, in cents. */
  feeCents: bigint;
  /** EURC base units the schedule predicts will arrive. Always >= target. */
  expectedNetUnits: bigint;
  /** expectedNetUnits - target: stays in the buyer's wallet. */
  surplusUnits: bigint;
}

/**
 * Smallest SEPA amount (in cents) that delivers at least `targetUnits` EURC
 * to the buyer's wallet under `schedule`, respecting the route minimum.
 */
export function quoteOnRamp(targetUnits: bigint, schedule: FeeSchedule): OnRampQuote {
  assertSchedule(schedule);
  if (targetUnits <= 0n) throw new RangeError("targetUnits must be positive");

  // Cents that must survive the fees: target plus destination-side fee, rounded up.
  const neededNetCents = unitsToCentsCeil(targetUnits + (schedule.destinationFeeUnits ?? 0n));
  // Closed-form estimate: gross * (1 - p) - fixed >= net  =>  gross >= (net + fixed) / (1 - p).
  const numer = (neededNetCents + schedule.fixedCents) * PPM;
  const denom = PPM - schedule.percentPpm;
  let gross = (numer + denom - 1n) / denom;
  // Per-cent rounding of the percentage fee can leave the estimate one or two
  // cents short; step up until the schedule says the target is met.
  while (onRampNetUnits(gross, schedule) < targetUnits) gross += 1n;
  if (schedule.minimumCents !== undefined && gross < schedule.minimumCents) {
    gross = schedule.minimumCents;
  }
  const net = onRampNetUnits(gross, schedule);
  return {
    sepaCents: gross,
    feeCents: onRampFeeCents(gross, schedule),
    expectedNetUnits: net,
    surplusUnits: net - targetUnits,
  };
}

export interface OffRampQuote {
  /** Whole cents the EURC amount converts to, before fees. */
  grossCents: bigint;
  feeCents: bigint;
  /** Euros the seller receives by SEPA, in cents. Never negative. */
  netCents: bigint;
  /** Sub-cent EURC dust that does not convert into a whole cent. */
  dustUnits: bigint;
  /** True when the amount is below the route minimum. */
  belowMinimum: boolean;
}

/**
 * What a seller receives by SEPA for an off-ramp of `units` EURC.
 *
 * TODO(verify, D5): how the gateway treats sub-cent EURC dust on an off-ramp.
 * Reported here as `dustUnits` and excluded from the payout.
 */
export function quoteOffRamp(units: bigint, schedule: FeeSchedule): OffRampQuote {
  assertSchedule(schedule);
  if (units < 0n) throw new RangeError("units must be non-negative");
  const grossCents = unitsToCentsFloor(units);
  const dustUnits = units - grossCents * EURC_UNITS_PER_CENT;
  const feeCents = percentFeeCents(grossCents, schedule.percentPpm) + schedule.fixedCents;
  const netCents = grossCents > feeCents ? grossCents - feeCents : 0n;
  return {
    grossCents,
    feeCents,
    netCents,
    dustUnits,
    belowMinimum: schedule.minimumCents !== undefined && grossCents < schedule.minimumCents,
  };
}
