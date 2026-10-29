// RegistryClient over Soroban RPC. Reads (verify, anchored_at) are simulations from a
// random throwaway source: nothing is signed or sent. Writes (anchor, revoke) are
// built, simulated, assembled, signed through the Signer port and sent through the
// Submitter port. Ported from the lab scripts (anchor call, send loop) and the Open
// Part Passport verifier (read-only simulation).
import {
  Account,
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  type Transaction,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { toU64 } from "./bytes.js";
import { MAX_DEPTH } from "./merkle.js";
import {
  type RegistryClient,
  RegistryError,
  RegistryErrorCode,
  type Signer,
  type SubmitResult,
  type Submitter,
  type WriteReceipt,
} from "./ports.js";

/** The subset of `rpc.Server` this module uses (injectable for tests). */
export type SorobanRpc = Pick<rpc.Server, "simulateTransaction" | "getAccount" | "sendTransaction" | "getTransaction">;

/** Public testnet defaults. Mainnet is deliberately not offered as a default here. */
export const TESTNET = { rpcUrl: "https://soroban-testnet.stellar.org", networkPassphrase: Networks.TESTNET } as const;

const u64 = (n: bigint) => nativeToScVal(toU64(n), { type: "u64" });
const u32 = (n: number) => nativeToScVal(n, { type: "u32" });
const bytes = (b: Uint8Array) => xdr.ScVal.scvBytes(Buffer.from(b));

/** Extracts the contract error code from a simulation error string, e.g. "Error(Contract, #5)". */
export function contractErrorCode(message: string): number | undefined {
  const m = /Error\(Contract, #(\d+)\)/.exec(message);
  return m ? Number(m[1]) : undefined;
}

function toRegistryError(message: string): Error {
  const code = contractErrorCode(message);
  return code !== undefined && code in RegistryErrorCode
    ? new RegistryError(code as RegistryErrorCode, message.slice(0, 200))
    : new Error(`simulation failed: ${message.slice(0, 300)}`);
}

export interface SorobanRegistryOptions {
  rpc: SorobanRpc;
  networkPassphrase: string;
  /** Claim registry contract ID (C...). */
  contractId: string;
  /** Issuer key, for `anchor`. */
  issuer?: Signer;
  /** Offline revoker key, for `revoke`. */
  revoker?: Signer;
  submitter?: Submitter;
  /** Inclusion fee in stroops for writes (resource fee is added by simulation). Default BASE_FEE. */
  fee?: string;
}

export class SorobanRegistryClient implements RegistryClient {
  private readonly contract: Contract;
  constructor(private readonly o: SorobanRegistryOptions) {
    this.contract = new Contract(o.contractId);
  }

  private async read(method: string, args: xdr.ScVal[]): Promise<unknown> {
    // Simulation needs a source account but never its secret; a random one is fine.
    const source = new Account(Keypair.random().publicKey(), "0");
    const tx = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: this.o.networkPassphrase })
      .addOperation(this.contract.call(method, ...args))
      .setTimeout(30)
      .build();
    const sim = await this.o.rpc.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) throw toRegistryError(sim.error);
    if (!sim.result) throw new Error(`${method}: simulation returned no result`);
    return scValToNative(sim.result.retval);
  }

  private async write(signer: Signer | undefined, method: string, args: xdr.ScVal[]): Promise<WriteReceipt> {
    if (!signer) throw new Error(`${method}: no signer configured`);
    if (!this.o.submitter) throw new Error(`${method}: no submitter configured`);
    const acct = await this.o.rpc.getAccount(signer.publicKey());
    const tx0 = new TransactionBuilder(acct, { fee: this.o.fee ?? BASE_FEE, networkPassphrase: this.o.networkPassphrase })
      .addOperation(this.contract.call(method, ...args))
      .setTimeout(300)
      .build();
    const sim = await this.o.rpc.simulateTransaction(tx0);
    if (rpc.Api.isSimulationError(sim)) throw toRegistryError(sim.error);
    const tx = rpc.assembleTransaction(tx0, sim).build();
    await signInto(tx, signer);
    const r = await this.o.submitter.send(tx);
    if (r.status !== "SUCCESS") throw new Error(`${method}: transaction ${r.hash} ${r.status}`);
    return { txHash: r.hash };
  }

  anchor(batchId: bigint, root: Uint8Array): Promise<WriteReceipt> {
    if (root.length !== 32) throw new TypeError("root must be 32 bytes");
    return this.write(this.o.issuer, "anchor", [u64(batchId), bytes(root)]);
  }

  revoke(batchId: bigint): Promise<WriteReceipt> {
    return this.write(this.o.revoker, "revoke", [u64(batchId)]);
  }

  async anchoredAt(batchId: bigint): Promise<bigint> {
    const v = await this.read("anchored_at", [u64(batchId)]);
    if (typeof v !== "bigint" && typeof v !== "number") throw new Error("anchored_at: unexpected return value");
    return BigInt(v);
  }

  async verify(batchId: bigint, leaf: Uint8Array, proof: Uint8Array[], index: number): Promise<boolean> {
    if (proof.length > MAX_DEPTH) throw new RegistryError(RegistryErrorCode.ProofTooLong);
    const v = await this.read("verify", [u64(batchId), bytes(leaf), xdr.ScVal.scvVec(proof.map(bytes)), u32(index)]);
    return v === true;
  }
}

/** Adds the signer's signature over the transaction hash. */
export async function signInto(tx: Transaction, signer: Signer): Promise<void> {
  const sig = await signer.signTxHash(tx.hash());
  tx.addSignature(signer.publicKey(), Buffer.from(sig).toString("base64"));
}

/** Submitter over Soroban RPC: send, then poll getTransaction until it lands. */
export class RpcSubmitter implements Submitter {
  constructor(
    private readonly server: Pick<rpc.Server, "sendTransaction" | "getTransaction">,
    private readonly pollMs = 1500,
    private readonly maxPolls = 40,
  ) {}

  async send(tx: Transaction): Promise<SubmitResult> {
    const r = await this.server.sendTransaction(tx);
    if (r.status === "ERROR") return { hash: r.hash, status: "REJECTED" };
    for (let i = 0; i < this.maxPolls; i++) {
      await new Promise((s) => setTimeout(s, this.pollMs));
      const g = await this.server.getTransaction(r.hash);
      if (g.status === rpc.Api.GetTransactionStatus.SUCCESS) return { hash: r.hash, status: "SUCCESS" };
      if (g.status === rpc.Api.GetTransactionStatus.FAILED) return { hash: r.hash, status: "FAILED" };
    }
    return { hash: r.hash, status: "TIMEOUT" };
  }
}
