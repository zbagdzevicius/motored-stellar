/**
 * Trustless Work v1 single-release escrow fee arithmetic, mirrored in
 * TypeScript so the reconciler can predict every outgoing EURC transfer to the
 * base unit.
 *
 * Source of truth: the Trustless Work escrow contract
 * (`modules/fee/calculator.rs` and `modules/fee/distribution.rs`, v1). The
 * contract is not vendored in this repo; its Wasm is fetched by hash (see
 * `contracts/third_party/tw-wasm`). The Python property test that first
 * cross-checked these formulas lives in the original lab and is reproduced as
 * `test/tw-math.test.ts`.
 *
 * - `release_funds` pays the whole `escrow.amount`: 0.3% to the Trustless Work
 *   fee account, `platform_fee` basis points to the platform account, the rest
 *   to the receiver. All three are integer floors.
 * - `resolve_dispute` and `withdraw_remaining_funds` take a map of recipient to
 *   gross amount. Fees are computed on the total, then each recipient bears
 *   `floor(amount * fee / total)` of each fee. Because both floors round down,
 *   a recipient can receive up to 1 unit per fee more than an exact pro-rata
 *   split; the reconciler predicts this exactly, so it is never "unexplained".
 */
import type { Units } from "./units.js";

/** Trustless Work's own fee, in basis points (hard-coded in the v1 contract). */
export const TW_FEE_BPS = 30n;

/** Basis-point denominator. */
export const BPS_DENOMINATOR = 10_000n;

/** Highest platform fee the v1 contract accepts (PlatformFeeTooHigh above). */
export const TW_MAX_PLATFORM_FEE_BPS = 9_900;

/** The three legs of a release of `amount`. */
export interface StandardFees {
  trustlessWorkFee: Units;
  platformFee: Units;
  receiverAmount: Units;
}

/** Mirror of `FeeCalculator::calculate_standard_fees`. */
export function standardFees(total: Units, platformFeeBps: number): StandardFees {
  if (total < 0n) throw new Error("total must be non-negative");
  if (!Number.isInteger(platformFeeBps) || platformFeeBps < 0) {
    throw new Error(`invalid platform fee bps: ${platformFeeBps}`);
  }
  const trustlessWorkFee = (total * TW_FEE_BPS) / BPS_DENOMINATOR;
  const platformFee = (total * BigInt(platformFeeBps)) / BPS_DENOMINATOR;
  return {
    trustlessWorkFee,
    platformFee,
    receiverAmount: total - trustlessWorkFee - platformFee,
  };
}

/** One recipient's share of a resolution or withdrawal. */
export interface RecipientShare {
  address: string;
  gross: Units;
  trustlessWorkFee: Units;
  platformFee: Units;
  net: Units;
}

/** Every transfer a distribution produces, grouped by leg. */
export interface Distribution {
  total: Units;
  trustlessWorkFee: Units;
  platformFee: Units;
  recipients: RecipientShare[];
}

/**
 * Mirror of `calculate_and_distribute_fees`: fees on the total, then each
 * recipient bears a floored pro-rata share of each fee.
 *
 * `shares` maps recipient address to gross amount; zero entries are skipped
 * (the contract rejects non-positive entries, so callers should not pass them,
 * but a zero refund leg is simply absent).
 */
export function distribute(shares: ReadonlyArray<readonly [string, Units]>, platformFeeBps: number): Distribution {
  const positive = shares.filter(([, amount]) => amount > 0n);
  for (const [, amount] of shares) {
    if (amount < 0n) throw new Error("distribution amounts must be non-negative");
  }
  const total = positive.reduce((acc, [, amount]) => acc + amount, 0n);
  if (total === 0n) return { total, trustlessWorkFee: 0n, platformFee: 0n, recipients: [] };

  const fees = standardFees(total, platformFeeBps);
  let twActual = 0n;
  let platformActual = 0n;
  const recipients: RecipientShare[] = positive.map(([address, gross]) => {
    const trustlessWorkFee = (gross * fees.trustlessWorkFee) / total;
    const platformFee = (gross * fees.platformFee) / total;
    twActual += trustlessWorkFee;
    platformActual += platformFee;
    return { address, gross, trustlessWorkFee, platformFee, net: gross - trustlessWorkFee - platformFee };
  });
  return { total, trustlessWorkFee: twActual, platformFee: platformActual, recipients };
}

/**
 * Release of a single-release escrow, expressed as a one-recipient
 * distribution. With one recipient, `floor(amount * fee / amount) = fee`, so
 * this equals `standardFees(amount, bps)` exactly.
 */
export function releaseDistribution(receiver: string, amount: Units, platformFeeBps: number): Distribution {
  return distribute([[receiver, amount]], platformFeeBps);
}

/**
 * Top-up owed to the buyer after a resolution or withdrawal pays them `gross`:
 * the two fee shares the contract deducted from the buyer's leg. Paying it
 * makes a refund whole (100% of what the buyer is owed).
 */
export function buyerTopUp(distribution: Distribution, buyer: string): Units {
  const share = distribution.recipients.find((r) => r.address === buyer);
  return share ? share.trustlessWorkFee + share.platformFee : 0n;
}
