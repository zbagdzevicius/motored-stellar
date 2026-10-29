/**
 * Amount helpers.
 *
 * EURC on Stellar has 7 decimal places. Every amount in this package is a
 * `bigint` count of those base units ("units"): 1 EURC = 10,000,000 units and
 * 1 euro cent = 100,000 units. Floating point is never used for money.
 */

/** Base units per whole EURC. */
export const UNITS_PER_EUR = 10_000_000n;

/** Base units per euro cent. */
export const UNITS_PER_CENT = 100_000n;

/** A non-negative or signed amount in EURC base units (7 decimals). */
export type Units = bigint;

/**
 * Parse a decimal euro string such as "12.34" or "0.0000001" into units.
 * Throws on more than 7 decimals or on anything that is not a plain decimal.
 */
export function eur(value: string): Units {
  const m = /^(-?)(\d+)(?:\.(\d{1,7}))?$/.exec(value.trim());
  if (!m) throw new Error(`not a decimal EUR amount: ${JSON.stringify(value)}`);
  const sign = m[1] === "-" ? -1n : 1n;
  const whole = BigInt(m[2] ?? "0");
  const frac = BigInt((m[3] ?? "").padEnd(7, "0"));
  return sign * (whole * UNITS_PER_EUR + frac);
}

/** Format units as a decimal EUR string with all 7 decimals. */
export function formatEur(units: Units): string {
  const neg = units < 0n;
  const abs = neg ? -units : units;
  const whole = abs / UNITS_PER_EUR;
  const frac = (abs % UNITS_PER_EUR).toString().padStart(7, "0");
  return `${neg ? "-" : ""}${whole}.${frac}`;
}

/**
 * Absolute difference in whole cents, rounded UP. A difference of a single
 * base unit still counts as one cent, so sub-cent drift can never hide inside
 * a "zero unexplained cents" report.
 */
export function unitsToCentsCeil(units: Units): bigint {
  const abs = units < 0n ? -units : units;
  return (abs + UNITS_PER_CENT - 1n) / UNITS_PER_CENT;
}

/** Sum a list of amounts. */
export function sum(values: Iterable<Units>): Units {
  let total = 0n;
  for (const v of values) total += v;
  return total;
}

/** Absolute value of a bigint. */
export function absUnits(v: Units): Units {
  return v < 0n ? -v : v;
}
