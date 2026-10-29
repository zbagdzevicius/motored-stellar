import { RampError } from "./errors.js";

/**
 * SEPA remittance reference rule as documented by the gateway for
 * `destination_sepa_reference`: 6 to 140 characters from a-z, A-Z, 0-9,
 * space, `&`, `-`, `.` and `/`.
 */
const SEPA_REFERENCE = /^[A-Za-z0-9 &\-./]{6,140}$/;

export function isValidSepaReference(ref: string): boolean {
  return SEPA_REFERENCE.test(ref);
}

export function assertSepaReference(ref: string): void {
  if (!isValidSepaReference(ref)) {
    throw new RampError(
      "SEPA_REFERENCE_INVALID",
      "SEPA reference must be 6-140 characters of a-z A-Z 0-9 space & - . /",
    );
  }
}
