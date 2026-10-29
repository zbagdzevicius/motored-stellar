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

import { TransactionBuilder, type Transaction, type xdr } from '@stellar/stellar-sdk';
import { guardErrorName, type GuardErrorName } from './errors.js';
import { escrowFromScVal, type OnChainEscrow } from './escrow-types.js';
import type { Submitter } from './ports.js';
import { addr, i128 } from './scval.js';
import { buildInvocation, simulateRead, SimulationError, type ContractCall } from './soroban.js';

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

/** Parses an unsigned funding XDR back, for a review screen that decodes before signing. */
export function decodeFundingXdr(unsignedXdr: string, networkPassphrase: string): Transaction {
  const tx = TransactionBuilder.fromXDR(unsignedXdr, networkPassphrase);
  if ('innerTransaction' in tx) throw new Error('expected a plain transaction');
  return tx;
}
