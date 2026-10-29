/**
 * Amount handling for the ramp boundary.
 *
 * Two integer scales meet here:
 *   - EUR on SEPA is counted in cents (2 decimals).
 *   - EURC on Stellar is counted in base units (7 decimals), the same scale the
 *     escrow and the Stellar Asset Contract use.
 *
 * Bridge's API carries amounts as decimal strings ("98.63"). Everything inside
 * this package is a bigint on one of the two integer scales; strings exist only
 * at the HTTP edge. No floating point is used anywhere.
 */

/** EURC base units per whole euro (Stellar assets have 7 decimals). */
export const EURC_UNITS_PER_EUR = 10_000_000n;
/** EURC base units per euro cent. */
export const EURC_UNITS_PER_CENT = 100_000n;
/** Decimal places of EURC on Stellar. */
export const EURC_DECIMALS = 7;
/** Decimal places of EUR on SEPA. */
export const EUR_DECIMALS = 2;

/** Converts cents to EURC base units at face value (1 EUR = 1 EURC). */
export function centsToUnits(cents: bigint): bigint {
  return cents * EURC_UNITS_PER_CENT;
}

/** Converts EURC base units to cents, rounding down (sub-cent dust is dropped). */
export function unitsToCentsFloor(units: bigint): bigint {
  if (units < 0n) throw new RangeError("units must be non-negative");
  return units / EURC_UNITS_PER_CENT;
}

/** Converts EURC base units to cents, rounding up. */
export function unitsToCentsCeil(units: bigint): bigint {
  if (units < 0n) throw new RangeError("units must be non-negative");
  return (units + EURC_UNITS_PER_CENT - 1n) / EURC_UNITS_PER_CENT;
}

/**
 * Formats an integer amount as a decimal string with exactly `decimals`
 * fractional digits, e.g. formatDecimal(201n, 2) === "2.01".
 */
export function formatDecimal(value: bigint, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0) throw new RangeError("bad decimals");
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  const frac = abs % scale;
  const body =
    decimals === 0 ? whole.toString() : `${whole}.${frac.toString().padStart(decimals, "0")}`;
  return negative ? `-${body}` : body;
}

/**
 * Parses a decimal string into an integer on the given scale. Rejects values
 * with more fractional digits than the scale holds instead of silently
 * rounding, so a malformed upstream amount never turns into a different number.
 */
export function parseDecimal(input: string, decimals: number): bigint {
  const s = input.trim();
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new RangeError(`not a decimal amount: ${JSON.stringify(input)}`);
  const [, sign, whole, fracRaw = ""] = m;
  // Trailing zeros beyond the scale are harmless ("120.000" at 2 decimals).
  const frac = fracRaw.replace(/0+$/, "");
  if (frac.length > decimals) {
    throw new RangeError(`${JSON.stringify(input)} has more than ${decimals} decimals`);
  }
  const scale = 10n ** BigInt(decimals);
  const value = BigInt(whole!) * scale + BigInt(frac.padEnd(decimals, "0") || "0");
  return sign ? -value : value;
}

/** "12.34" -> 1234n */
export const parseCents = (s: string): bigint => parseDecimal(s, EUR_DECIMALS);
/** 1234n -> "12.34" */
export const formatCents = (c: bigint): string => formatDecimal(c, EUR_DECIMALS);
/** "1.5" -> 15000000n */
export const parseUnits = (s: string): bigint => parseDecimal(s, EURC_DECIMALS);
/** 15000000n -> "1.5000000" */
export const formatUnits = (u: bigint): string => formatDecimal(u, EURC_DECIMALS);
