// SPDX-License-Identifier: Apache-2.0
//
// Amount units. Every on-chain amount in this package is a bigint in the asset's
// 7-decimal base unit (1 EURC = 10,000,000 units), the unit the Stellar Asset
// Contract and the Trustless Work escrow use. Order maths happens in euro cents
// and is lifted to units only at the boundary.

/** Decimal places of a Stellar classic asset as seen through its SAC. */
export const DECIMALS = 7;

/** Units per whole token (1 EURC). */
export const UNITS_PER_TOKEN = 10_000_000n;

/** Units per euro cent. */
export const UNITS_PER_CENT = 100_000n;

/** Converts an integer number of euro cents to 7-decimal units. */
export function centsToUnits(cents: bigint): bigint {
  return cents * UNITS_PER_CENT;
}

/**
 * Parses a non-negative decimal string ("12.5", "0.0000001") into 7-decimal units.
 * Rejects more than 7 fractional digits instead of rounding, so no value is ever
 * silently changed.
 */
export function parseUnits(decimal: string): bigint {
  const s = decimal.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new RangeError(`not a non-negative decimal: ${decimal}`);
  const [whole = '0', frac = ''] = s.split('.');
  if (frac.length > DECIMALS) throw new RangeError(`more than ${DECIMALS} decimals: ${decimal}`);
  return BigInt(whole) * UNITS_PER_TOKEN + BigInt(frac.padEnd(DECIMALS, '0'));
}

/** Formats 7-decimal units as a decimal string with trailing zeros removed. */
export function formatUnits(units: bigint): string {
  const neg = units < 0n;
  const abs = neg ? -units : units;
  const whole = abs / UNITS_PER_TOKEN;
  const frac = (abs % UNITS_PER_TOKEN).toString().padStart(DECIMALS, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

/** Floor division for bigints (BigInt `/` truncates toward zero). */
export function floorDiv(a: bigint, b: bigint): bigint {
  if (b === 0n) throw new RangeError('division by zero');
  const q = a / b;
  return (a % b !== 0n) && ((a < 0n) !== (b < 0n)) ? q - 1n : q;
}
