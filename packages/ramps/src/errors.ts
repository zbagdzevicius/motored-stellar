/** Stable error codes raised by this package. */
export type RampErrorCode =
  /** The escrow receiver or a payout target is not a plain Stellar G-address. */
  | "RECEIVER_NOT_PLAIN_ACCOUNT"
  /** The escrow receiver is a ramp deposit address (memo-routed, never valid as receiver). */
  | "RECEIVER_IS_RAMP_ADDRESS"
  /** The wallet has no EURC trustline yet, so an on-ramp would have nowhere to land. */
  | "TRUSTLINE_MISSING"
  /** The customer is not KYC/KYB-approved for this operation. */
  | "KYC_NOT_APPROVED"
  /** Travel Rule payload is incomplete or inconsistent. */
  | "TRAVEL_RULE_INVALID"
  /** A SEPA reference does not satisfy the rail's charset or length. */
  | "SEPA_REFERENCE_INVALID"
  /** An off-ramp payment does not match the stored deposit address and memo. */
  | "OFFRAMP_DESTINATION_MISMATCH"
  /** Configuration is unsafe or incomplete (for example a live key on the sandbox). */
  | "CONFIG_INVALID"
  /** Referenced resource does not exist. */
  | "NOT_FOUND"
  /** Request is not valid for the current state of a resource. */
  | "INVALID_STATE";

/** Error raised by local validation, before or instead of a provider call. */
export class RampError extends Error {
  readonly code: RampErrorCode;
  constructor(code: RampErrorCode, message: string) {
    super(message);
    this.name = "RampError";
    this.code = code;
  }
}

/**
 * Error returned by the Bridge API. Mirrors Bridge's documented error object
 * (`code`, `message`, optional `source { location, key }`). The API key is
 * never part of the message.
 */
export class BridgeApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly source: { location: string; key: string } | undefined;
  readonly path: string;
  constructor(args: {
    status: number;
    code: string;
    message: string;
    path: string;
    source?: { location: string; key: string };
  }) {
    super(`Bridge API ${args.status} on ${args.path}: ${args.code}: ${args.message}`);
    this.name = "BridgeApiError";
    this.status = args.status;
    this.code = args.code;
    this.source = args.source;
    this.path = args.path;
  }
}
