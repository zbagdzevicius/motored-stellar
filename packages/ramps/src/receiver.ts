/**
 * Address rules at the boundary between the escrow and the ramp.
 *
 * Why this exists: the gateway identifies a Stellar deposit to its omnibus
 * account either by a memo or by a muxed (M-) address that encodes the memo.
 * The Trustless Work v1 escrow pays its receiver as a plain `Address`: it does
 * not apply its `receiver_memo` field to the payout, and an `Address` role
 * cannot hold a muxed account. An escrow whose receiver is a ramp deposit
 * address would therefore pay the gateway without the routing memo, and the
 * funds could be unrecoverable.
 *
 * Rule: the escrow receiver is always the seller's own plain G-address. The
 * seller cashes out afterwards with a separate classic payment from that
 * wallet to the stored liquidation address (memoless address, or address plus
 * memo), which `checkOffRampPayment` verifies before signing.
 */

import { StrKey } from "@stellar/stellar-sdk";
import { RampError } from "./errors.js";
import type { LiquidationAddress } from "./ports.js";

/** True for a valid ed25519 account address (G...). */
export function isPlainAccount(address: string): boolean {
  return address.startsWith("G") && StrKey.isValidEd25519PublicKey(address);
}

/** True for a valid muxed account address (M...). */
export function isMuxedAccount(address: string): boolean {
  return address.startsWith("M") && StrKey.isValidMed25519PublicKey(address);
}

/**
 * Asserts that `receiver` may be used as the escrow's receiver (and as an
 * on-ramp destination):
 *   - it is a plain, valid G-address (not muxed M..., not a contract C...);
 *   - it is not one of the gateway deposit addresses the platform has stored,
 *     which are memo-routed and must never receive an escrow payout.
 *
 * @param rampDepositAddresses every gateway deposit account (liquidation
 *   `address` values) known to the platform, across all sellers.
 */
export function assertEscrowReceiver(
  receiver: string,
  rampDepositAddresses: Iterable<string> = [],
): void {
  if (!isPlainAccount(receiver)) {
    const kind = isMuxedAccount(receiver)
      ? "a muxed (M-) address"
      : receiver.startsWith("C")
        ? "a contract (C-) address"
        : "not a valid G-address";
    throw new RampError(
      "RECEIVER_NOT_PLAIN_ACCOUNT",
      `escrow receiver must be the seller's own plain G-address; got ${kind}`,
    );
  }
  for (const ramp of rampDepositAddresses) {
    if (ramp === receiver) {
      throw new RampError(
        "RECEIVER_IS_RAMP_ADDRESS",
        "escrow receiver is a ramp deposit address; escrow payouts carry no memo, so the gateway could not route them",
      );
    }
  }
}

/** The target of a seller's classic off-ramp payment. */
export type OffRampTarget =
  | { kind: "memoless"; destination: string }
  | { kind: "memo"; destination: string; memo: string };

/**
 * Chooses where a seller's off-ramp payment goes. Prefers the memoless
 * (muxed) address when the gateway returned one, so the payment cannot lose
 * its memo; otherwise the deposit address plus the routing memo.
 */
export function offRampTarget(la: LiquidationAddress): OffRampTarget {
  if (la.memolessAddress) return { kind: "memoless", destination: la.memolessAddress };
  if (!la.memo) {
    throw new RampError(
      "INVALID_STATE",
      "liquidation address on Stellar has neither a memoless address nor a memo",
    );
  }
  return { kind: "memo", destination: la.address, memo: la.memo };
}

/**
 * Checks a payment the seller is about to sign against the stored liquidation
 * address. Call this right before signing; a mismatch means the client is
 * about to send funds somewhere the gateway cannot route.
 */
export function checkOffRampPayment(
  stored: LiquidationAddress,
  payment: { destination: string; memo?: string },
): void {
  if (stored.state !== "active") {
    throw new RampError("OFFRAMP_DESTINATION_MISMATCH", "liquidation address is not active");
  }
  if (stored.memolessAddress && payment.destination === stored.memolessAddress) {
    // A muxed destination already encodes the memo; a second text memo is
    // ambiguous, so refuse it.
    if (payment.memo !== undefined && payment.memo !== "") {
      throw new RampError(
        "OFFRAMP_DESTINATION_MISMATCH",
        "payment to a memoless address must not carry a separate memo",
      );
    }
    return;
  }
  if (payment.destination !== stored.address) {
    throw new RampError(
      "OFFRAMP_DESTINATION_MISMATCH",
      "payment destination is not the stored liquidation address",
    );
  }
  if (!stored.memo || payment.memo !== stored.memo) {
    throw new RampError(
      "OFFRAMP_DESTINATION_MISMATCH",
      "payment to the liquidation address must carry its routing memo",
    );
  }
}
