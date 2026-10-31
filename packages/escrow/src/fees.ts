// SPDX-License-Identifier: Apache-2.0
//
// Money rules for an EURC escrow order (pre-award; used by SCF deliverable D3).
//
// The seller must net in EURC at least what the card rail pays for the same order
// (`cardNet`: each item's gross minus the marketplace commission, rounded per item)
// and at most 1 basis point of the escrow amount more, plus at most 2 units of
// Trustless Work flooring. The platform fee in basis points is the one free
// parameter of a v1 escrow, so it is solved from that target:
//
//   platform_fee_bps = floor((9970 * amount - 10000 * card_net) / amount)
//
// with `amount` and `card_net` in the same unit (7-decimal units on-chain).
// Trustless Work's 0.3% comes out of the platform's share (buyer fee and
// commission). An order is eligible for the escrow rail only when the result is
// between 0 and the guard's cap (`max_platform_fee_bps`, at most Trustless Work's
// 9,900).
//
// Shipping is not in the escrow. Motored buys the DPD label, so the buyer pays
// shipping straight to the pinned platform address as a plain EURC payment in
// the funding step (`shippingToPlatform` on the quote; see `precheck.ts`
// `buildShippingPaymentTransaction`). The escrow holds items plus the buyer fee
// only, so its platform fee is at most the commission plus the buyer fee, under
// the 1,000 bps cap planned for mainnet. A shipping refund is Motored's, as on
// the card rail.
//
// The Trustless Work arithmetic below mirrors the v1 single-release contract
// (`modules/fee/calculator.rs` and `modules/fee/distribution.rs`, branch
// `single-release-main`): both fees are floored on the same base, each recipient's
// share of a resolution is floored, and the recipient's net is the remainder.
//
// Ported from the lab's property test (fee_prop.py, fee_fix.py). Rate inputs are
// parameters with documented defaults; nothing here reads a marketplace's code.

import { floorDiv } from './units.js';

/** Trustless Work protocol fee, basis points (`TRUSTLESS_WORK_FEE_BPS` in the v1 contract). */
export const TW_FEE_BPS = 30n;
/** Basis-point denominator. */
export const BPS_DENOMINATOR = 10_000n;
/** Highest `platform_fee` a v1 escrow accepts (99%). */
export const TW_MAX_PLATFORM_FEE_BPS = 9_900n;
/**
 * The guard's `max_platform_fee_bps` planned for mainnet (10%). With shipping
 * outside the escrow, 5% commission plus a buyer fee of at most 5% quotes about
 * 922 bps (9.2%, Trustless Work's 0.3% included), under this cap. Testnet run 9
 * deployed 500 (`scripts/testnet/deploy.ts`).
 */
export const MAINNET_MAX_PLATFORM_FEE_BPS = 1_000n;

/** The marketplace's card-rail fee schedule. All rates in basis points, caps in cents. */
export interface FeeSchedule {
  /** Commission taken from each item's gross on the card rail. Default 500 (5%). */
  commissionBps: bigint;
  /** Buyer fee on the item subtotal. Default 500 (5%). */
  buyerFeeBps: bigint;
  /** Cap on the buyer fee, in cents. Default 500 (EUR 5). */
  buyerFeeCapCents: bigint;
}

export const DEFAULT_FEE_SCHEDULE: Readonly<FeeSchedule> = Object.freeze({
  commissionBps: 500n,
  buyerFeeBps: 500n,
  buyerFeeCapCents: 500n,
});

export type FeeRuleErrorCode =
  | 'INVALID_AMOUNT'
  | 'PLATFORM_FEE_NEGATIVE'
  | 'PLATFORM_FEE_ABOVE_CAP'
  | 'INVALID_DISTRIBUTION';

export class FeeRuleError extends Error {
  constructor(public readonly code: FeeRuleErrorCode, message: string) {
    super(message);
    this.name = 'FeeRuleError';
  }
}

/** `amount * bps / 10000`, rounded half up (the card rail's rounding). */
export function applyBps(amount: bigint, bps: bigint): bigint {
  if (amount < 0n || bps < 0n) throw new FeeRuleError('INVALID_AMOUNT', 'applyBps takes non-negative values');
  return (amount * bps + BPS_DENOMINATOR / 2n) / BPS_DENOMINATOR;
}

/** Buyer fee in cents: `buyerFeeBps` of the subtotal, half up, capped; 0 under a referral code. */
export function buyerFeeCents(
  subtotalCents: bigint,
  referral: boolean,
  schedule: FeeSchedule = DEFAULT_FEE_SCHEDULE,
): bigint {
  if (referral) return 0n;
  const fee = applyBps(subtotalCents, schedule.buyerFeeBps);
  return fee < schedule.buyerFeeCapCents ? fee : schedule.buyerFeeCapCents;
}

/** What the card rail pays the seller, in cents: each item's gross minus commission, rounded per item. */
export function cardNetCents(itemGrossCents: readonly bigint[], schedule: FeeSchedule = DEFAULT_FEE_SCHEDULE): bigint {
  return itemGrossCents.reduce((sum, g) => sum + g - applyBps(g, schedule.commissionBps), 0n);
}

/**
 * Escrow amount in cents for a single-seller cart: items + buyer fee as charged.
 * Shipping is not escrowed; it goes to the platform address (`orderAmountsCents`).
 */
export function escrowAmountCents(
  input: { itemGrossCents: readonly bigint[]; referral: boolean },
  schedule: FeeSchedule = DEFAULT_FEE_SCHEDULE,
): bigint {
  const subtotal = input.itemGrossCents.reduce((a, b) => a + b, 0n);
  return subtotal + buyerFeeCents(subtotal, input.referral, schedule);
}

/** What a single-seller cart charges the buyer on the EURC rail, in cents. */
export interface OrderAmountsCents {
  /** Items + buyer fee: the escrow amount. */
  escrowCents: bigint;
  /** Shipping, paid to the pinned platform address in the funding step, outside the escrow. */
  shippingToPlatformCents: bigint;
  /** Card-rail seller net: items minus commission, rounded per item. */
  cardNetCents: bigint;
  /** `escrowCents + shippingToPlatformCents`: what the buyer pays in all, as on the card rail. */
  buyerPaysCents: bigint;
}

/** Splits a cart into the escrowed part and the shipping paid to the platform. */
export function orderAmountsCents(
  input: { itemGrossCents: readonly bigint[]; shippingCents: bigint; referral: boolean },
  schedule: FeeSchedule = DEFAULT_FEE_SCHEDULE,
): OrderAmountsCents {
  if (input.shippingCents < 0n) throw new FeeRuleError('INVALID_AMOUNT', 'shipping must be non-negative');
  const escrowCents = escrowAmountCents(input, schedule);
  return {
    escrowCents,
    shippingToPlatformCents: input.shippingCents,
    cardNetCents: cardNetCents(input.itemGrossCents, schedule),
    buyerPaysCents: escrowCents + input.shippingCents,
  };
}

/** Result of Trustless Work's `calculate_standard_fees(total, platform_fee_bps)`. */
export interface StandardFees {
  trustlessWorkFee: bigint;
  platformFee: bigint;
  receiverAmount: bigint;
}

/** Mirrors `FeeCalculator::calculate_standard_fees`: both fees floored on `total`, receiver gets the rest. */
export function twStandardFees(total: bigint, platformFeeBps: bigint): StandardFees {
  if (total < 0n) throw new FeeRuleError('INVALID_AMOUNT', 'total must be non-negative');
  const trustlessWorkFee = (total * TW_FEE_BPS) / BPS_DENOMINATOR;
  const platformFee = (total * platformFeeBps) / BPS_DENOMINATOR;
  return { trustlessWorkFee, platformFee, receiverAmount: total - trustlessWorkFee - platformFee };
}

/**
 * The platform fee (bps) that makes the seller net at least `cardNet`:
 * `floor((9970 * amount - 10000 * cardNet) / amount)`. Not range-checked; see `quoteEscrow`.
 */
export function platformFeeBps(amount: bigint, cardNet: bigint): bigint {
  if (amount <= 0n) throw new FeeRuleError('INVALID_AMOUNT', 'escrow amount must be positive');
  if (cardNet < 0n) throw new FeeRuleError('INVALID_AMOUNT', 'card net must be non-negative');
  return floorDiv((BPS_DENOMINATOR - TW_FEE_BPS) * amount - BPS_DENOMINATOR * cardNet, amount);
}

export interface EscrowQuote {
  /** Escrow amount (items + buyer fee), 7-decimal units. */
  amount: bigint;
  /**
   * Shipping the buyer pays to the platform address in the funding step, outside
   * the escrow, 7-decimal units (0 when the order has none). Not part of `amount`,
   * the platform fee or the release.
   */
  shippingToPlatform: bigint;
  /** Card-rail seller net, 7-decimal units. */
  cardNet: bigint;
  /** `platform_fee` to set on the escrow. */
  platformFeeBps: bigint;
  /** What a release pays out, per Trustless Work's arithmetic. */
  release: StandardFees;
  /** Seller's EURC net minus card net (>= 0, at most 1 bp of amount + 2 units). Logged per order. */
  sellerOverCardNet: bigint;
}

export interface QuoteOptions {
  /** The guard's `max_platform_fee_bps`. Default Trustless Work's 9,900; mainnet plans `MAINNET_MAX_PLATFORM_FEE_BPS`. */
  maxPlatformFeeBps?: bigint;
}

/**
 * Quotes an escrow for an order. Throws `FeeRuleError` when the order is not
 * eligible for the escrow rail (fee would be negative or above the cap, which
 * happens only for carts of items around EUR 1, where the card rail's per-item
 * rounding outweighs the rates).
 */
export function quoteEscrow(
  input: { amount: bigint; cardNet: bigint; shippingToPlatform?: bigint },
  opts: QuoteOptions = {},
): EscrowQuote {
  const cap = opts.maxPlatformFeeBps ?? TW_MAX_PLATFORM_FEE_BPS;
  if (cap < 0n || cap > TW_MAX_PLATFORM_FEE_BPS) throw new FeeRuleError('INVALID_AMOUNT', `cap ${cap} bps outside 0..${TW_MAX_PLATFORM_FEE_BPS}`);
  const shippingToPlatform = input.shippingToPlatform ?? 0n;
  if (shippingToPlatform < 0n) throw new FeeRuleError('INVALID_AMOUNT', 'shipping must be non-negative');
  const bps = platformFeeBps(input.amount, input.cardNet);
  if (bps < 0n) {
    throw new FeeRuleError('PLATFORM_FEE_NEGATIVE', `platform fee ${bps} bps < 0: card net exceeds 99.7% of the amount`);
  }
  if (bps > cap) {
    throw new FeeRuleError('PLATFORM_FEE_ABOVE_CAP', `platform fee ${bps} bps > ${cap}: card rail only`);
  }
  const release = twStandardFees(input.amount, bps);
  return {
    amount: input.amount,
    shippingToPlatform,
    cardNet: input.cardNet,
    platformFeeBps: bps,
    release,
    sellerOverCardNet: release.receiverAmount - input.cardNet,
  };
}

/** True when `quoteEscrow` would succeed. */
export function isEscrowEligible(input: { amount: bigint; cardNet: bigint }, opts: QuoteOptions = {}): boolean {
  try {
    quoteEscrow(input, opts);
    return true;
  } catch (e) {
    if (e instanceof FeeRuleError) return false;
    throw e;
  }
}

export interface ResolutionSplit {
  /** Total Trustless Work fee actually transferred (sum of floored per-recipient shares). */
  trustlessWorkFee: bigint;
  /** Total platform fee actually transferred. */
  platformFee: bigint;
  /** Net transfer per recipient (recipients whose net is 0 receive nothing). */
  net: Array<{ address: string; amount: bigint }>;
}

/**
 * Mirrors `resolve_dispute` / `withdraw_remaining_funds` fee handling: standard fees
 * on the distribution total, then each recipient pays
 * `floor(amount * fee / total)` of each fee and receives the remainder.
 */
export function resolutionSplit(
  distributions: ReadonlyArray<readonly [string, bigint]>,
  platformFeeBpsValue: bigint,
): ResolutionSplit {
  if (distributions.length === 0) throw new FeeRuleError('INVALID_DISTRIBUTION', 'empty distribution');
  let total = 0n;
  for (const [, amount] of distributions) {
    if (amount <= 0n) throw new FeeRuleError('INVALID_DISTRIBUTION', 'every distribution amount must be positive');
    total += amount;
  }
  const std = twStandardFees(total, platformFeeBpsValue);
  let tw = 0n;
  let pf = 0n;
  const net: ResolutionSplit['net'] = [];
  for (const [address, amount] of distributions) {
    const rTw = (amount * std.trustlessWorkFee) / total;
    const rPf = (amount * std.platformFee) / total;
    tw += rTw;
    pf += rPf;
    const n = amount - rTw - rPf;
    if (n > 0n) net.push({ address, amount: n });
  }
  return { trustlessWorkFee: tw, platformFee: pf, net };
}

export interface RefundTopUp {
  /** What the escrow pays the buyer when the whole balance is resolved to them. */
  paidFromEscrow: bigint;
  /** Trustless Work fee + platform fee withheld by the resolution: the platform sends this back. */
  topUp: bigint;
  /** `paidFromEscrow + topUp`; always equals the refunded balance. */
  buyerReceives: bigint;
  /** The platform's net cost of the refund (the Trustless Work fee). */
  platformCost: bigint;
}

/**
 * Refund before release: the resolution to the buyer withholds both fees; the
 * platform then tops the buyer up by exactly those two amounts from its fee
 * account, so the buyer receives 100% of the balance, like a card refund.
 */
export function refundTopUp(balance: bigint, platformFeeBpsValue: bigint, buyer = 'buyer'): RefundTopUp {
  const split = resolutionSplit([[buyer, balance]], platformFeeBpsValue);
  const paidFromEscrow = split.net.reduce((a, r) => a + r.amount, 0n);
  const topUp = split.trustlessWorkFee + split.platformFee;
  return { paidFromEscrow, topUp, buyerReceives: paidFromEscrow + topUp, platformCost: split.trustlessWorkFee };
}

/**
 * Distribution for a seller-favoured resolution: the seller gets at most the escrow
 * amount (the guard refuses more, error #28) and any excess goes to the buyer.
 */
export function sellerResolution(
  balance: bigint,
  escrowAmount: bigint,
  seller: string,
  buyer: string,
): Array<[string, bigint]> {
  if (balance <= 0n) throw new FeeRuleError('INVALID_DISTRIBUTION', 'nothing to resolve');
  const toSeller = balance < escrowAmount ? balance : escrowAmount;
  const excess = balance - toSeller;
  return excess > 0n ? [[seller, toSeller], [buyer, excess]] : [[seller, toSeller]];
}
