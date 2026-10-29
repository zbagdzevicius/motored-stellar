/**
 * Pre-sign review.
 *
 * Before a user signs, the app decodes the transaction and shows what it does
 * (for an escrow call: contract ID, function, amount and asset), so a wallet
 * that signs a bare hash never signs blind. `summarizeTransaction` produces a
 * plain JSON-safe description that a UI can render; it does not interpret any
 * particular contract's arguments.
 */
import { Buffer } from 'buffer';
import { Address, Asset, Transaction, scValToNative, xdr } from '@stellar/stellar-sdk';

import { WalletError } from './errors.js';

export interface OperationSummary {
  type: string;
  /** Operation source, when it differs from the transaction source. */
  source?: string;
  /** Soroban contract calls. */
  contractId?: string;
  function?: string;
  /** Contract arguments decoded to JSON-safe values (bigints and i128 as decimal strings, bytes as `0x` hex). */
  args?: unknown[];
  /** Classic payments, account creation and trustlines. */
  destination?: string;
  asset?: string;
  amount?: string;
}

export interface TransactionSummary {
  hash: string;
  networkPassphrase: string;
  source: string;
  /** Maximum fee in stroops, as the envelope states it. */
  fee: string;
  sequence: string;
  memo?: string;
  operations: OperationSummary[];
}

/**
 * Called before any adapter asks the user to sign. Return `false` (or throw) to
 * refuse; the adapter then fails with `REJECTED_BY_USER`.
 */
export type BeforeSignHook = (summary: TransactionSummary, tx: Transaction) => Promise<boolean | void> | boolean | void;

function assetLabel(asset: Asset): string {
  return asset.isNative() ? 'XLM' : `${asset.getCode()}:${asset.getIssuer()}`;
}

/** Converts decoded ScVal output into values `JSON.stringify` can print. */
function toJsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) return `0x${Buffer.from(value).toString('hex')}`;
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, toJsonSafe(v)]));
  }
  return value;
}

function summarizeHostFunction(func: xdr.HostFunction): Pick<OperationSummary, 'contractId' | 'function' | 'args'> {
  if (func.switch().value !== xdr.HostFunctionType.hostFunctionTypeInvokeContract().value) {
    return { function: func.switch().name };
  }
  const call = func.invokeContract();
  return {
    contractId: Address.fromScAddress(call.contractAddress()).toString(),
    function: call.functionName().toString(),
    args: call.args().map((arg) => toJsonSafe(scValToNative(arg))),
  };
}

export function summarizeTransaction(tx: Transaction): TransactionSummary {
  const operations = tx.operations.map((op): OperationSummary => {
    const base: OperationSummary = { type: op.type };
    if (op.source && op.source !== tx.source) base.source = op.source;
    switch (op.type) {
      case 'invokeHostFunction':
        return { ...base, ...summarizeHostFunction(op.func) };
      case 'payment':
        return { ...base, destination: op.destination, asset: assetLabel(op.asset), amount: op.amount };
      case 'createAccount':
        return { ...base, destination: op.destination, asset: 'XLM', amount: op.startingBalance };
      case 'changeTrust':
        return { ...base, asset: op.line instanceof Asset ? assetLabel(op.line) : 'liquidity-pool-share', amount: op.limit };
      default:
        return base;
    }
  });

  const summary: TransactionSummary = {
    hash: tx.hash().toString('hex'),
    networkPassphrase: tx.networkPassphrase,
    source: tx.source,
    fee: tx.fee,
    sequence: tx.sequence,
    operations,
  };
  if (tx.memo.type !== 'none' && tx.memo.value !== null) {
    summary.memo = Buffer.isBuffer(tx.memo.value) ? `0x${tx.memo.value.toString('hex')}` : String(tx.memo.value);
  }
  return summary;
}

/** Runs the hook if present and converts a refusal into an exception. */
export async function runBeforeSign(hook: BeforeSignHook | undefined, tx: Transaction): Promise<void> {
  if (!hook) return;
  const verdict = await hook(summarizeTransaction(tx), tx);
  if (verdict === false) {
    throw new WalletError('REJECTED_BY_USER', 'the transaction was declined at review');
  }
}
