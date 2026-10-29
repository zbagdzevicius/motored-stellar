/**
 * Shared fixtures: random keys, an XEUR stand-in, a registry with one buyer
 * wallet, and builders for every inner-transaction shape the fee-bump policy
 * knows about. Nothing here touches a network.
 */
import {
  Account,
  Address,
  Asset,
  BASE_FEE,
  Keypair,
  Memo,
  Networks,
  Operation,
  SorobanDataBuilder,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";
import { randomBytes } from "node:crypto";
import {
  FeeBumpPolicy,
  InMemoryWalletRegistry,
  KeypairSigner,
  attachSignature,
  type FeeBumpPolicyConfig,
  type Signer,
} from "../src/index.js";

export const NP = Networks.TESTNET;
export const randomContract = (): string => StrKey.encodeContract(randomBytes(32));

export function world() {
  const sponsor = KeypairSigner.random();
  const buyer = KeypairSigner.random();
  const stranger = KeypairSigner.random();
  const issuer = Keypair.random();
  const xeur = new Asset("XEUR", issuer.publicKey());
  const escrow = randomContract();
  const otherEscrow = randomContract();
  const guard = randomContract();
  const rampAddress = Keypair.random().publicKey();
  const registry = new InMemoryWalletRegistry().register(buyer.publicKey(), {
    escrows: [escrow],
    ramp: { address: rampAddress },
  });
  const policyConfig: FeeBumpPolicyConfig = {
    networkPassphrase: NP,
    eurc: xeur,
    guardContractId: guard,
    sponsorPublicKey: sponsor.publicKey(),
    registry,
  };
  return {
    sponsor,
    buyer,
    stranger,
    issuer,
    xeur,
    escrow,
    otherEscrow,
    guard,
    rampAddress,
    registry,
    policyConfig,
    policy: (over: Partial<FeeBumpPolicyConfig> = {}) => new FeeBumpPolicy({ ...policyConfig, ...over }),
  };
}

export interface BuildOpts {
  fee?: string;
  resourceFee?: number;
  timeout?: number;
  memo?: Memo;
  passphrase?: string;
}

/** Build and sign an inner tx with `ops`, sourced from `signer`'s account. */
export async function innerTx(signer: Signer, ops: xdr.Operation[], o: BuildOpts = {}): Promise<Transaction> {
  const b = new TransactionBuilder(new Account(signer.publicKey(), "100"), {
    fee: o.fee ?? BASE_FEE,
    networkPassphrase: o.passphrase ?? NP,
    memo: o.memo,
  });
  for (const op of ops) b.addOperation(op);
  if (o.resourceFee !== undefined) b.setSorobanData(new SorobanDataBuilder().setResourceFee(o.resourceFee).build());
  const tx = b.setTimeout(o.timeout ?? 120).build();
  await attachSignature(tx, signer);
  return tx;
}

export const addr = (a: string) => new Address(a).toScVal();
export const i128 = (n: bigint) => nativeToScVal(n, { type: "i128" });
export const u32 = (n: number) => nativeToScVal(n, { type: "u32" });

export function call(contract: string, fn: string, args: xdr.ScVal[], auth: xdr.SorobanAuthorizationEntry[] = []) {
  return Operation.invokeContractFunction({ contract, function: fn, args, auth });
}

/** fund_escrow(signer, expected_escrow, amount); expected_escrow is opaque to the policy. */
export const fundEscrow = (escrow: string, signer: string, amount = 1_000_000_000n) =>
  call(escrow, "fund_escrow", [addr(signer), xdr.ScVal.scvVoid(), i128(amount)]);

/** An auth entry with address credentials for `who` (someone else's signature). */
export function addressAuth(who: string, contract: string): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(who).toScAddress(),
        nonce: xdr.Int64.fromString("1"),
        signatureExpirationLedger: 100,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: new Address(contract).toScAddress(),
          functionName: "fund_escrow",
          args: [],
        }),
      ),
      subInvocations: [],
    }),
  });
}

export { Account, Memo, Operation, Keypair, Asset, BASE_FEE };
