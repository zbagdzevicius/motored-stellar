/**
 * Small, typed readers over stellar-sdk's decoded operations. Kept apart from
 * the policy so that the policy reads as a list of rules.
 */
import { Address, scValToNative, xdr, type OperationRecord, type Transaction } from "@stellar/stellar-sdk";

/** A decoded `InvokeHostFunction(InvokeContract)` call. */
export interface ContractCall {
  readonly contractId: string;
  readonly fn: string;
  readonly args: readonly xdr.ScVal[];
  readonly auth: readonly xdr.SorobanAuthorizationEntry[];
  /** Operation-level source, if set. */
  readonly source?: string;
}

/**
 * Decode `op` as a contract call; null for any other host function (upload,
 * create contract) or any non-Soroban operation.
 */
export function asContractCall(op: OperationRecord): ContractCall | null {
  if (op.type !== "invokeHostFunction") return null;
  const func = op.func;
  if (func.type !== "hostFunctionTypeInvokeContract") return null;
  const ic = func.invokeContract;
  return {
    contractId: Address.fromScAddress(ic.contractAddress).toString(),
    fn: Buffer.from(ic.functionName.bytes).toString("utf8"),
    args: ic.args,
    auth: op.auth ?? [],
    source: op.source,
  };
}

/** Decode an ScVal expected to be an address; null otherwise. */
export function scAddress(v: xdr.ScVal | undefined): string | null {
  if (!v || v.type !== "scvAddress") return null;
  return Address.fromScAddress(v.address).toString();
}

/** Decode an ScVal expected to be a u32; null otherwise. */
export function scU32(v: xdr.ScVal | undefined): number | null {
  if (!v || v.type !== "scvU32") return null;
  return v.u32;
}

/** Decode an ScVal expected to be an i128; null otherwise. */
export function scI128(v: xdr.ScVal | undefined): bigint | null {
  if (!v || v.type !== "scvI128") return null;
  return scValToNative(v) as bigint;
}

/** Decode an ScVal expected to be bytes of a fixed length; null otherwise. */
export function scBytesN(v: xdr.ScVal | undefined, n: number): Buffer | null {
  if (!v || v.type !== "scvBytes") return null;
  const b = Buffer.from(v.bytes.value);
  return b.length === n ? b : null;
}

/** True when every auth entry uses source-account credentials. */
export function onlySourceAccountAuth(auth: readonly xdr.SorobanAuthorizationEntry[]): boolean {
  return auth.every((a) => a.credentials.type === "sorobanCredentialsSourceAccount");
}

/** Declared Soroban resource fee of `tx` in stroops; 0n for a classic tx. */
export function declaredResourceFee(tx: Transaction): bigint {
  const env = tx.toEnvelope();
  if (env.type !== "envelopeTypeTx") return 0n;
  const ext = env.v1.tx.ext;
  if (ext.type !== "sorobanData") return 0n;
  return BigInt(ext.sorobanData.resourceFee);
}

/** True when `tx` carries a Soroban operation. */
export function isSorobanTx(tx: Transaction): boolean {
  return tx.operations.some(
    (o) => o.type === "invokeHostFunction" || o.type === "extendFootprintTtl" || o.type === "restoreFootprint",
  );
}
