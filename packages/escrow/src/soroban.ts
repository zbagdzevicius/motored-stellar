// SPDX-License-Identifier: Apache-2.0
//
// Contract-call plumbing over the Submitter port: build an invocation, read by
// simulation, and the plain (non-guarded) simulate -> assemble -> sign -> submit
// path. Ported from the lab's `build`, `read` and `plain` helpers (arch8.mjs).

import { Operation, TransactionBuilder, type Transaction, type xdr } from '@stellar/stellar-sdk';
import { contractErrorCode } from './errors.js';
import type { Signer, SignXdr, SimulationOutcome, Submitter, SubmitResult } from './ports.js';

export interface ContractCall {
  contractId: string;
  fn: string;
  args: xdr.ScVal[];
}

export interface BuildOptions {
  networkPassphrase: string;
  /** Inclusion fee in stroops before simulation adds the resource fee. Default 1,000,000 (lab value). */
  fee?: string;
  timeoutSeconds?: number;
  /** Authorization entries to attach to the invocation. */
  auth?: xdr.SorobanAuthorizationEntry[];
}

/** Builds a one-operation transaction that invokes `call` with `sourcePublicKey` as source. */
export async function buildInvocation(
  submitter: Submitter,
  sourcePublicKey: string,
  call: ContractCall,
  opts: BuildOptions,
): Promise<Transaction> {
  const account = await submitter.getAccount(sourcePublicKey);
  const op = Operation.invokeContractFunction({
    contract: call.contractId,
    function: call.fn,
    args: call.args,
    ...(opts.auth ? { auth: opts.auth } : {}),
  });
  return new TransactionBuilder(account, { fee: opts.fee ?? '1000000', networkPassphrase: opts.networkPassphrase })
    .addOperation(op)
    .setTimeout(opts.timeoutSeconds ?? 300)
    .build();
}

export type ReadResult = { ok: true; retval: xdr.ScVal | undefined } | { ok: false; error: string; contractErrorCode?: number };

/** Calls a read-only function by simulation. Nothing is submitted. */
export async function simulateRead(
  submitter: Submitter,
  sourcePublicKey: string,
  call: ContractCall,
  networkPassphrase: string,
): Promise<ReadResult> {
  const tx = await buildInvocation(submitter, sourcePublicKey, call, { networkPassphrase });
  const sim = await submitter.simulate(tx);
  if (!sim.ok) return { ok: false, error: sim.error, contractErrorCode: sim.contractErrorCode ?? contractErrorCode(sim.error) };
  return { ok: true, retval: sim.retval };
}

/** Adds a raw ed25519 signature from `signer` over the transaction hash. */
export async function signTransaction(tx: Transaction, signer: Signer): Promise<Transaction> {
  const sig = await signer.signTxHash(tx.hash());
  tx.addSignature(signer.publicKey(), Buffer.from(sig).toString('base64'));
  return tx;
}

/** `SignXdr` for real Stellar envelopes (Trustless Work REST returns these). */
export function stellarSignXdr(networkPassphrase: string): SignXdr {
  return async (unsignedXdr, signer) => {
    const tx = TransactionBuilder.fromXDR(unsignedXdr, networkPassphrase);
    if ('innerTransaction' in tx) throw new Error('refusing to sign a fee-bump envelope as a user transaction');
    await signTransaction(tx, signer);
    return tx.toXDR();
  };
}

export class SimulationError extends Error {
  constructor(public readonly outcome: Extract<SimulationOutcome, { ok: false }>, label: string) {
    super(`${label}: simulation failed: ${outcome.error.split('\n')[0]?.slice(0, 300)}`);
    this.name = 'SimulationError';
  }
  get contractErrorCode(): number | undefined {
    return this.outcome.contractErrorCode ?? contractErrorCode(this.outcome.error);
  }
}

/**
 * Plain invocation where the transaction source is also the only signer
 * (for example the platform's `update_escrow`, or `register_escrow` by the submitter).
 * Simulates, assembles, signs and submits.
 */
export async function invokeAndSubmit(
  submitter: Submitter,
  signer: Signer,
  call: ContractCall,
  networkPassphrase: string,
): Promise<SubmitResult> {
  const tx = await buildInvocation(submitter, signer.publicKey(), call, { networkPassphrase });
  const sim = await submitter.simulate(tx);
  if (!sim.ok) throw new SimulationError(sim, `${call.fn}`);
  const ready = sim.prepare(tx);
  await signTransaction(ready, signer);
  return submitter.send(ready);
}
