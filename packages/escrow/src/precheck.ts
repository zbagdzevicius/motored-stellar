// SPDX-License-Identifier: Apache-2.0
//
// Funding precheck. Before a buyer is handed the `fund_escrow` call, the escrow is
// confirmed in two independent ways, both by simulation (nothing is submitted):
//
//  1. `guard.check_escrow(escrow)`: pinned Trustless Work Wasm, guard in both
//     roles, EURC trustline, pinned platform address, receiver == service
//     provider, every flag false, every milestone status non-empty and unapproved,
//     and a zero balance;
//  2. `escrow.get_escrow()` re-read and matched against the order: amount,
//     platform fee, approver, receiver, service provider and receiver memo (the
//     guard does not check these).
//
// The buyer's `fund_escrow(signer, expected_escrow, amount)` then carries the
// exact state just read as `expected_escrow`, so the buyer's signature commits to
// roles and flags and the call fails if anything changes in between.
//
// Shipping is not escrowed (see `fees.ts`): the buyer pays it to the escrow's
// pinned `platform` address as a plain EURC payment in the same funding step.
// A Soroban transaction carries exactly one operation, so the payment cannot sit
// inside the `fund_escrow` transaction; `buildFundingTransactions` builds it as
// the next transaction in the buyer's sequence, so it is valid only once the
// funding transaction has used the sequence number before it. The order is paid
// only when both have landed; a shipping payment without a funded escrow is
// refunded by Motored, as on the card rail.

import { Account, Asset, Memo, Operation, TransactionBuilder, type Transaction, type xdr } from '@stellar/stellar-sdk';
import { guardErrorName, type GuardErrorName } from './errors.js';
import { escrowFromScVal, type OnChainEscrow } from './escrow-types.js';
import type { Submitter } from './ports.js';
import { addr, i128 } from './scval.js';
import { buildInvocation, simulateRead, SimulationError, type ContractCall } from './soroban.js';
import { formatUnits } from './units.js';

export interface ExpectedTerms {
  amount: bigint;
  platformFeeBps: bigint | number;
  buyer: string;
  seller: string;
  receiverMemo?: number;
}

export type PrecheckResult =
  | {
      ok: true;
      escrow: OnChainEscrow;
      /** The `get_escrow` value, passed verbatim as `expected_escrow`. */
      expectedEscrow: xdr.ScVal;
      /** The call to hand the buyer. */
      fundingCall: ContractCall;
    }
  | { ok: false; stage: 'guard'; guardError?: GuardErrorName; contractErrorCode?: number; error: string }
  | { ok: false; stage: 'read'; error: string }
  | { ok: false; stage: 'terms'; mismatches: string[] };

/** Compares an escrow against the order's terms; returns the mismatching fields. */
export function termMismatches(e: OnChainEscrow, t: ExpectedTerms): string[] {
  const m: string[] = [];
  if (e.amount !== t.amount) m.push('amount');
  if (BigInt(e.platformFeeBps) !== BigInt(t.platformFeeBps)) m.push('platform_fee');
  if (e.roles.approver !== t.buyer) m.push('roles.approver');
  if (e.roles.serviceProvider !== t.seller) m.push('roles.service_provider');
  if (e.roles.receiver !== t.seller) m.push('roles.receiver');
  if (e.receiverMemo !== (t.receiverMemo ?? 0)) m.push('receiver_memo');
  return m;
}

export async function precheckEscrow(
  rpc: Submitter,
  args: {
    networkPassphrase: string;
    /** Any funded account to simulate from (the submitter). */
    sourcePublicKey: string;
    guardContractId: string;
    escrowContractId: string;
    terms: ExpectedTerms;
  },
): Promise<PrecheckResult> {
  const guard = await simulateRead(
    rpc,
    args.sourcePublicKey,
    { contractId: args.guardContractId, fn: 'check_escrow', args: [addr(args.escrowContractId)] },
    args.networkPassphrase,
  );
  if (!guard.ok) {
    return { ok: false, stage: 'guard', error: guard.error, contractErrorCode: guard.contractErrorCode, guardError: guardErrorName(guard.contractErrorCode) };
  }

  const read = await simulateRead(rpc, args.sourcePublicKey, { contractId: args.escrowContractId, fn: 'get_escrow', args: [] }, args.networkPassphrase);
  if (!read.ok || !read.retval) return { ok: false, stage: 'read', error: read.ok ? 'get_escrow returned nothing' : read.error };

  const escrow = escrowFromScVal(read.retval);
  const mismatches = termMismatches(escrow, args.terms);
  if (mismatches.length) return { ok: false, stage: 'terms', mismatches };

  return {
    ok: true,
    escrow,
    expectedEscrow: read.retval,
    fundingCall: {
      contractId: args.escrowContractId,
      fn: 'fund_escrow',
      args: [addr(args.terms.buyer), read.retval, i128(args.terms.amount)],
    },
  };
}

/**
 * Builds the buyer's funding transaction (buyer as source, simulated and
 * assembled) and returns it unsigned, for the buyer's wallet to sign. A sponsor
 * may wrap the signed transaction in a fee bump (see packages/eurc).
 */
export async function buildFundingTransaction(
  rpc: Submitter,
  networkPassphrase: string,
  buyer: string,
  precheck: Extract<PrecheckResult, { ok: true }>,
): Promise<{ tx: Transaction; unsignedXdr: string }> {
  const tx = await buildInvocation(rpc, buyer, precheck.fundingCall, { networkPassphrase, fee: '100' });
  const sim = await rpc.simulate(tx);
  if (!sim.ok) throw new SimulationError(sim, 'fund_escrow');
  const ready = sim.prepare(tx);
  return { tx: ready, unsignedXdr: ready.toXDR() };
}

/** Shipping the buyer pays to the platform address in the funding step, outside the escrow. */
export interface ShippingPayment {
  /** The EURC classic asset (code and issuer); the escrow's trustline is its SAC. */
  asset: Asset;
  /** Shipping, 7-decimal units (`EscrowQuote.shippingToPlatform`). Must be positive. */
  amount: bigint;
  /** Optional 32-byte memo hash, e.g. the order reference, so the payment matches its order. */
  memoHash?: Buffer;
}

/**
 * Builds the buyer's shipping payment: one classic EURC payment from the buyer
 * to `platform`, sequenced right after `previous` (the funding transaction), so
 * it is valid only after that sequence number is used. Unsigned.
 */
export function buildShippingPaymentTransaction(
  networkPassphrase: string,
  previous: Pick<Transaction, 'source' | 'sequence'>,
  platform: string,
  shipping: ShippingPayment,
  opts: { fee?: string; timeoutSeconds?: number } = {},
): { tx: Transaction; unsignedXdr: string } {
  if (shipping.amount <= 0n) throw new RangeError('shipping amount must be positive');
  if (shipping.asset.isNative()) throw new RangeError('shipping is paid in EURC, not XLM');
  const builder = new TransactionBuilder(new Account(previous.source, previous.sequence), {
    fee: opts.fee ?? '100',
    networkPassphrase,
    ...(shipping.memoHash ? { memo: Memo.hash(shipping.memoHash) } : {}),
  });
  const tx = builder
    .addOperation(Operation.payment({ destination: platform, asset: shipping.asset, amount: formatUnits(shipping.amount) }))
    .setTimeout(opts.timeoutSeconds ?? 300)
    .build();
  return { tx, unsignedXdr: tx.toXDR() };
}

/**
 * The buyer's whole funding step: the `fund_escrow` transaction and, when the
 * order has shipping, the shipping payment to the escrow's pinned platform
 * address as the next transaction in the buyer's sequence. Both unsigned, for
 * the buyer's wallet to review and sign; a sponsor may fee-bump each one.
 */
export async function buildFundingTransactions(
  rpc: Submitter,
  networkPassphrase: string,
  buyer: string,
  precheck: Extract<PrecheckResult, { ok: true }>,
  shipping?: ShippingPayment,
): Promise<{ funding: { tx: Transaction; unsignedXdr: string }; shipping?: { tx: Transaction; unsignedXdr: string } }> {
  const funding = await buildFundingTransaction(rpc, networkPassphrase, buyer, precheck);
  if (!shipping || shipping.amount === 0n) return { funding };
  // Paid only to the address the guard pinned as the escrow's platform (checked by check_escrow).
  const platform = precheck.escrow.roles.platform;
  return { funding, shipping: buildShippingPaymentTransaction(networkPassphrase, funding.tx, platform, shipping) };
}

/** Parses an unsigned funding XDR back, for a review screen that decodes before signing. */
export function decodeFundingXdr(unsignedXdr: string, networkPassphrase: string): Transaction {
  const tx = TransactionBuilder.fromXDR(unsignedXdr, networkPassphrase);
  if ('innerTransaction' in tx) throw new Error('expected a plain transaction');
  return tx;
}
