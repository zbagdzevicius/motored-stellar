// SPDX-License-Identifier: Apache-2.0
//
// Error codes of the escrow guard contract (`contracts/guard`, enum GErr) and a
// helper that extracts a contract error code from a Soroban simulation error.

export const GUARD_ERRORS = Object.freeze({
  1: 'NotRegistered',
  2: 'WrongRole',
  3: 'NotFunded',
  4: 'Changed',
  5: 'BadContext',
  6: 'BadFn',
  8: 'NoClaim',
  9: 'BadRecipient',
  10: 'TooEarly',
  11: 'BadToken',
  12: 'BadWasm',
  13: 'NotWholeToBuyer',
  14: 'BadArgs',
  15: 'BadFeeAddr',
  16: 'ClaimPredatesEscrow',
  17: 'Closed',
  18: 'AlreadySettled',
  19: 'NoPending',
  20: 'Timelocked',
  21: 'BadMilestone',
  22: 'BadPlatform',
  23: 'BadRoles',
  24: 'NotEmpty',
  25: 'Contested',
  26: 'ContestTooLate',
  27: 'NoDisputeSeen',
  28: 'SellerOverAmount',
  29: 'PlatformFeeOverCap',
} as const);

export type GuardErrorCode = keyof typeof GUARD_ERRORS;
export type GuardErrorName = (typeof GUARD_ERRORS)[GuardErrorCode];

/** Pulls `#N` out of an `Error(Contract, #N)` simulation error string. */
export function contractErrorCode(simulationError: string): number | undefined {
  const m = /Error\(Contract, #(\d+)\)/.exec(simulationError);
  return m ? Number(m[1]) : undefined;
}

/** Guard error name for a code, if the code is one of the guard's. */
export function guardErrorName(code: number | undefined): GuardErrorName | undefined {
  if (code === undefined) return undefined;
  return (GUARD_ERRORS as Record<number, GuardErrorName>)[code];
}

/** Raised when a lifecycle step is not allowed in the escrow's current state. */
export class EscrowStateError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'EscrowStateError';
  }
}

/** Raised by the release service when a guarded call fails simulation or submission. */
export class GuardedCallError extends Error {
  constructor(
    message: string,
    public readonly stage: 'record-simulation' | 'enforce-simulation' | 'submit',
    public readonly contractCode?: number,
  ) {
    super(message);
    this.name = 'GuardedCallError';
  }
  /**
   * Guard error name for the contract code. A code can also come from the escrow
   * contract itself (Trustless Work's own error enum), so treat this as a hint and
   * keep `message` for the full simulation error.
   */
  get guardError(): GuardErrorName | undefined {
    return guardErrorName(this.contractCode);
  }
}
