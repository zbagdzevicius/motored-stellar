/**
 * Small, typed readers over stellar-sdk's decoded operations. Kept apart from
 * the policy so that the policy reads as a list of rules.
 */
import { Address, scValToNative, xdr, type Operation, type Transaction } from "@stellar/stellar-sdk";

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
export function asContractCall(op: Operation): ContractCall | null {
  if (op.type !== "invokeHostFunction") return null;
  const func = op.func;
  if (func.switch().name !== "hostFunctionTypeInvokeContract") return null;
  const ic = func.invokeContract();
  const name = ic.functionName();
  return {
    contractId: Address.fromScAddress(ic.contractAddress()).toString(),
    fn: typeof name === "string" ? name : Buffer.from(name).toString("utf8"),
    args: ic.args(),
    auth: op.auth ?? [],
    source: op.source,
  };
}

/** Decode an ScVal expected to be an address; null otherwise. */
export function scAddress(v: xdr.ScVal | undefined): string | null {
  if (!v || v.switch().name !== "scvAddress") return null;
  return Address.fromScAddress(v.address()).toString();
}

/** Decode an ScVal expected to be a u32; null otherwise. */
export function scU32(v: xdr.ScVal | undefined): number | null {
  if (!v || v.switch().name !== "scvU32") return null;
  return v.u32();
}

/** Decode an ScVal expected to be an i128; null otherwise. */
export function scI128(v: xdr.ScVal | undefined): bigint | null {
  if (!v || v.switch().name !== "scvI128") return null;
  return scValToNative(v) as bigint;
}

/** Decode an ScVal expected to be bytes of a fixed length; null otherwise. */
export function scBytesN(v: xdr.ScVal | undefined, n: number): Buffer | null {
  if (!v || v.switch().name !== "scvBytes") return null;
  const b = Buffer.from(v.bytes());
  return b.length === n ? b : null;
}

/** True when every auth entry uses source-account credentials. */
export function onlySourceAccountAuth(auth: readonly xdr.SorobanAuthorizationEntry[]): boolean {
  return auth.every((a) => a.credentials().switch().name === "sorobanCredentialsSourceAccount");
}

/** Declared Soroban resource fee of `tx` in stroops; 0n for a classic tx. */
export function declaredResourceFee(tx: Transaction): bigint {
  const env = tx.toEnvelope();
  if (env.switch().name !== "envelopeTypeTx") return 0n;
  const ext = env.v1().tx().ext();
  if (ext.switch() !== 1) return 0n;
  return BigInt(ext.sorobanData().resourceFee().toString());
}

/** True when `tx` carries a Soroban operation. */
export function isSorobanTx(tx: Transaction): boolean {
  return tx.operations.some(
    (o) => o.type === "invokeHostFunction" || o.type === "extendFootprintTtl" || o.type === "restoreFootprint",
  );
}
