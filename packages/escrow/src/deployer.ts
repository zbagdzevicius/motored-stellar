// SPDX-License-Identifier: Apache-2.0
//
// Fallback escrow creation through Trustless Work's on-chain deployer entry
// point, used if the v1 REST API does not accept the guard's contract address in
// the escrow roles. `initialize_escrow` itself needs no authorization, so the
// deployment and the initialization must happen in the same transaction; the
// deployer entry point does exactly that. It deploys whatever Wasm hash it is
// given, which is why the guard checks the escrow's Wasm hash itself.
//
// Call shape ported from arch8.mjs `newEscrow`:
//   deployer.tw_new_single_release_escrow(
//     deployer: Address, wasm_hash: BytesN<32>, salt: BytesN<32>,
//     init_fn: Symbol = "initialize_escrow", init_args: Vec<Val> = [escrow],
//     constructor_args: Vec<Val> = [])
// and returns a tuple whose first element is the new escrow's address.

import { randomBytes } from 'node:crypto';
import { scValToNative } from '@stellar/stellar-sdk';
import { escrowToScVal, type OnChainEscrow } from './escrow-types.js';
import type { Signer, Submitter } from './ports.js';
import { addr, bytes, sym, vec } from './scval.js';
import { invokeAndSubmit, type ContractCall } from './soroban.js';

export interface DeployerCallParams {
  /**
   * Contract ID of Trustless Work's deployer on this network.
   * TODO(verify, D1 live API run): obtain the official testnet deployer contract ID from Trustless Work; the lab used its own deployment.
   */
  deployerContractId: string;
  /** Account that pays for and authorizes the deployment. */
  deployerAddress: string;
  /** Hex SHA-256 of the Trustless Work Wasm to deploy (must be the hash the guard pins). */
  wasmHash: string;
  /** 32 random bytes; defaults to fresh randomness. */
  salt?: Uint8Array;
  /** Fully final escrow: every milestone status non-empty, all flags false. */
  escrow: OnChainEscrow;
}

export function deployerCall(p: DeployerCallParams): ContractCall {
  const wasm = Buffer.from(p.wasmHash, 'hex');
  if (wasm.length !== 32) throw new RangeError('wasmHash must be 32 bytes of hex');
  const salt = p.salt ?? randomBytes(32);
  if (salt.length !== 32) throw new RangeError('salt must be 32 bytes');
  if (p.escrow.flags.disputed || p.escrow.flags.released || p.escrow.flags.resolved) throw new Error('flags must all be false at creation');
  if (p.escrow.milestones.length === 0 || p.escrow.milestones.some((m) => m.status === '' || m.approved)) {
    throw new Error('every milestone needs a non-empty status and approved=false before the escrow is created');
  }
  return {
    contractId: p.deployerContractId,
    fn: 'tw_new_single_release_escrow',
    args: [addr(p.deployerAddress), bytes(wasm), bytes(salt), sym('initialize_escrow'), vec([escrowToScVal(p.escrow)]), vec([])],
  };
}

/** Deploys and initializes an escrow in one transaction; returns its contract ID. */
export async function deployEscrowOnChain(
  rpc: Submitter,
  signer: Signer,
  networkPassphrase: string,
  params: Omit<DeployerCallParams, 'deployerAddress'>,
): Promise<{ escrowContractId: string; txHash: string }> {
  const call = deployerCall({ ...params, deployerAddress: signer.publicKey() });
  const r = await invokeAndSubmit(rpc, signer, call, networkPassphrase);
  if (r.status !== 'SUCCESS' || !r.returnValue) throw new Error(`deploy failed: ${r.hash} ${r.status}`);
  const ret = scValToNative(r.returnValue) as unknown;
  const id = Array.isArray(ret) ? ret[0] : ret;
  if (typeof id !== 'string' || !id.startsWith('C')) throw new Error('deployer did not return a contract address');
  return { escrowContractId: id, txHash: r.hash };
}
