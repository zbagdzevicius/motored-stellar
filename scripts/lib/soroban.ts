/**
 * Soroban RPC plumbing for the testnet CLIs: build, simulate, sign, submit,
 * guard-authorised calls and the fee-bump Wasm upload.
 *
 * Ported from the lab scripts (architect/testnet-v08/arch8.mjs and upload.mjs).
 * The lab loaded keys with `stellar keys show`; here every signer is a Keypair
 * handed in by the caller from the KeyStore. Every submitted transaction is
 * recorded in `runLog` so a run can be exported with its public tx hashes.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  Account,
  Address,
  Asset,
  Contract,
  Keypair,
  Operation,
  Transaction,
  TransactionBuilder,
  rpc,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';
import type { NetworkConfig } from './network.js';
import { txLink } from './network.js';
import { claimToScVal, type AnchoredClaim } from './claims.js';
import { bytes, map, variant } from './scval.js';
import { GUARD_ERRORS } from './tw.js';

const sha256 = (b: Uint8Array): Buffer => createHash('sha256').update(b).digest();

/** Base fee for contract calls; the resource fee comes from simulation. */
const CONTRACT_BASE_FEE = '1000000';
const POLL_ATTEMPTS = 40;
const POLL_MS = 1500;

export type TxStatus = 'SUCCESS' | 'FAILED' | 'REJECTED' | 'TIMEOUT';

export interface TxRecord {
  label: string;
  hash: string;
  status: TxStatus;
  link: string;
}

export interface TxResult extends TxRecord {
  returnValue?: xdr.ScVal;
}

export interface Refusal {
  label: string;
  refused: string;
}

export interface SimCost {
  instructions?: number;
  minResourceFee?: string;
  error?: string;
}

/** Which guard branch a signature selects (contracts/guard GuardSig). */
export type GuardBranch =
  | { kind: 'Release' }
  | { kind: 'Resolve' }
  | { kind: 'BreakGlass' }
  | { kind: 'ResolveSeller'; claim: AnchoredClaim };

/** Turns a simulation into a cost line or a readable error with the guard's error name. */
export function simCost(sim: rpc.Api.SimulateTransactionResponse): SimCost {
  if (rpc.Api.isSimulationError(sim)) {
    const m = sim.error.match(/Error\(Contract, #(\d+)\)/);
    if (m) {
      const code = Number(m[1]);
      const name = GUARD_ERRORS[code];
      return { error: `Error(Contract, #${code})${name ? ` ${name} (if raised by the guard)` : ''}` };
    }
    return { error: sim.error.slice(0, 200) };
  }
  if (!rpc.Api.isSimulationSuccess(sim) || !sim.transactionData) return { error: 'simulation needs restore' };
  const r = sim.transactionData.build().resources();
  return { instructions: r.instructions(), minResourceFee: sim.minResourceFee };
}

/** ScVal for a guard signature in the given branch. */
export function guardSignature(branch: GuardBranch, sig: Buffer): xdr.ScVal {
  if (branch.kind === 'ResolveSeller') return variant('ResolveSeller', map({ claim: claimToScVal(branch.claim), sig: bytes(sig) }));
  return variant(branch.kind, bytes(sig));
}

export class Chain {
  readonly server: rpc.Server;
  readonly runLog: Array<TxRecord | Refusal | { label: string; note: unknown }> = [];

  constructor(
    readonly cfg: NetworkConfig,
    private readonly print: (line: string) => void = (l) => console.log(l),
    server?: rpc.Server,
  ) {
    this.server = server ?? new rpc.Server(cfg.rpcUrl, { allowHttp: cfg.rpcUrl.startsWith('http://') });
  }

  note(label: string, data?: unknown): void {
    this.print(data === undefined ? `   ${label}` : `   ${label} ${JSON.stringify(data, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`);
    this.runLog.push({ label, note: data ?? null });
  }

  private record(r: TxResult): TxResult {
    this.runLog.push({ label: r.label, hash: r.hash, status: r.status, link: r.link });
    this.print(`== ${r.label}: ${r.status} ${r.link}`);
    return r;
  }

  private refuse(label: string, reason: string): Refusal {
    const r = { label, refused: reason };
    this.runLog.push(r);
    this.print(`== ${label}: REFUSED ${reason}`);
    return r;
  }

  async contractTx(source: string, contractId: string, fn: string, args: xdr.ScVal[], auth?: xdr.SorobanAuthorizationEntry[]): Promise<Transaction> {
    const acct = await this.server.getAccount(source);
    const op = new Contract(contractId).call(fn, ...args);
    if (auth) op.body().invokeHostFunctionOp().auth(auth);
    return new TransactionBuilder(acct, { fee: CONTRACT_BASE_FEE, networkPassphrase: this.cfg.passphrase }).addOperation(op).setTimeout(300).build();
  }

  /** Signs (with every signer), submits and polls until the transaction lands. */
  async send(label: string, tx: Transaction | ReturnType<typeof TransactionBuilder.buildFeeBumpTransaction>, signers: Keypair[]): Promise<TxResult> {
    for (const s of signers) tx.sign(s);
    const r = await this.server.sendTransaction(tx);
    const link = txLink(this.cfg, r.hash);
    if (r.status === 'ERROR') return this.record({ label, hash: r.hash, status: 'REJECTED', link });
    for (let i = 0; i < POLL_ATTEMPTS; i++) {
      await new Promise((ok) => setTimeout(ok, POLL_MS));
      const g = await this.server.getTransaction(r.hash);
      if (g.status === rpc.Api.GetTransactionStatus.SUCCESS) return this.record({ label, hash: r.hash, status: 'SUCCESS', link, returnValue: g.returnValue });
      if (g.status === rpc.Api.GetTransactionStatus.FAILED) return this.record({ label, hash: r.hash, status: 'FAILED', link });
    }
    return this.record({ label, hash: r.hash, status: 'TIMEOUT', link });
  }

  /** Simulate, assemble and submit a contract call signed by `signer` (also the source). */
  async invoke(label: string, signer: Keypair, contractId: string, fn: string, args: xdr.ScVal[]): Promise<TxResult | Refusal> {
    const tx0 = await this.contractTx(signer.publicKey(), contractId, fn, args);
    const sim = await this.server.simulateTransaction(tx0);
    if (rpc.Api.isSimulationError(sim)) return this.refuse(label, simCost(sim).error ?? 'simulation error');
    return this.send(label, rpc.assembleTransaction(tx0, sim).build(), [signer]);
  }

  /**
   * Read-only call by simulation. `source` only needs to be a valid G-address.
   * TODO(verify): RPC simulation with a source account that does not exist on
   * the ledger; the lab always used a funded account.
   */
  async read(contractId: string, fn: string, args: xdr.ScVal[], source: string): Promise<{ val: xdr.ScVal } | { error: string }> {
    const op = new Contract(contractId).call(fn, ...args);
    const tx = new TransactionBuilder(new Account(source, '0'), { fee: CONTRACT_BASE_FEE, networkPassphrase: this.cfg.passphrase })
      .addOperation(op)
      .setTimeout(300)
      .build();
    const sim = await this.server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) return { error: simCost(sim).error ?? 'simulation error' };
    if (!rpc.Api.isSimulationSuccess(sim) || !sim.result) return { error: 'no result' };
    return { val: sim.result.retval };
  }

  async readNative<T = unknown>(contractId: string, fn: string, args: xdr.ScVal[], source: string): Promise<T> {
    const r = await this.read(contractId, fn, args, source);
    if ('error' in r) throw new Error(`${fn} on ${contractId}: ${r.error}`);
    return scValToNative(r.val) as T;
  }

  /** Signs one Soroban auth entry for the guard's __check_auth with a raw ed25519 key. */
  async signGuardEntry(entry: xdr.SorobanAuthorizationEntry, key: Keypair, branch: GuardBranch): Promise<xdr.SorobanAuthorizationEntry> {
    const latest = (await this.server.getLatestLedger()).sequence;
    const creds = entry.credentials().address();
    creds.signatureExpirationLedger(latest + 200);
    const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
      new xdr.HashIdPreimageSorobanAuthorization({
        networkId: sha256(Buffer.from(this.cfg.passphrase)),
        nonce: creds.nonce(),
        signatureExpirationLedger: creds.signatureExpirationLedger(),
        invocation: entry.rootInvocation(),
      }),
    );
    creds.signature(guardSignature(branch, key.sign(sha256(preimage.toXDR()))));
    return entry;
  }

  /**
   * A guard-authorised escrow call: record-mode simulation -> sign the guard's
   * auth entry -> enforce-mode simulation -> submit when `submit` is set and the
   * enforce simulation passes. Refused paths return the guard's error.
   */
  async guarded(
    label: string,
    submitter: Keypair,
    escrow: string,
    fn: string,
    args: xdr.ScVal[],
    key: Keypair,
    branch: GuardBranch,
    submit: boolean,
  ): Promise<TxResult | Refusal | { label: string; cost: SimCost }> {
    const rec = await this.server.simulateTransaction(await this.contractTx(submitter.publicKey(), escrow, fn, args));
    if (rpc.Api.isSimulationError(rec)) return this.refuse(`${label} (record-sim)`, simCost(rec).error ?? 'error');
    if (!rpc.Api.isSimulationSuccess(rec) || !rec.result || rec.result.auth.length === 0) return this.refuse(label, 'no auth entry to sign');
    const signed = await this.signGuardEntry(rec.result.auth[0] as xdr.SorobanAuthorizationEntry, key, branch);
    const tx1 = await this.contractTx(submitter.publicKey(), escrow, fn, args, [signed]);
    // TODO(verify): the authMode argument of simulateTransaction in the pinned SDK (the lab used it on 14.x).
    const enf = await this.server.simulateTransaction(tx1, undefined, 'enforce');
    const cost = simCost(enf);
    if (cost.error) return this.refuse(label, cost.error);
    if (!submit) {
      this.note(`${label}: enforce-sim passes`, cost);
      return { label, cost };
    }
    this.note(`${label}: enforce-sim cost`, cost);
    return this.send(label, rpc.assembleTransaction(tx1, enf).build(), [submitter]);
  }

  /** Classic operations (trustlines, payments) in one transaction. */
  async classic(label: string, source: Keypair, ops: xdr.Operation[], extraSigners: Keypair[] = []): Promise<TxResult> {
    const acct = await this.server.getAccount(source.publicKey());
    const b = new TransactionBuilder(acct, { fee: '1000', networkPassphrase: this.cfg.passphrase }).setTimeout(300);
    for (const op of ops) b.addOperation(op);
    return this.send(label, b.build(), [source, ...extraSigners]);
  }

  /**
   * Uploads a Wasm through a fee-bump. On testnet a plain upload of the guard
   * exceeded the u32 fee field (resource fee about 493 XLM for 32 KB), so the
   * inner transaction keeps a small fee, carries the simulated Soroban data, and
   * the fee-bump pays the resource fee. Ported from upload.mjs.
   * Returns the Wasm hash (hex).
   */
  async uploadWasmFeeBump(label: string, wasm: Buffer, payer: Keypair): Promise<string> {
    const hash = sha256(wasm).toString('hex');
    const acct = await this.server.getAccount(payer.publicKey());
    const tx0 = new TransactionBuilder(acct, { fee: '100', networkPassphrase: this.cfg.passphrase })
      .addOperation(Operation.uploadContractWasm({ wasm }))
      .setTimeout(300)
      .build();
    const sim = await this.server.simulateTransaction(tx0);
    if (rpc.Api.isSimulationError(sim)) {
      // An already-uploaded Wasm still simulates fine; any error here is real.
      throw new Error(`${label}: upload simulation failed: ${simCost(sim).error}`);
    }
    if (!rpc.Api.isSimulationSuccess(sim) || !sim.transactionData) throw new Error(`${label}: no soroban data`);
    // Inner fee stays a small u32; the declared resource fee lives in the Soroban data,
    // and the fee-bump below pays it. The lab patched the envelope by hand; the
    // builder's setSorobanData does the same without touching the fee.
    // TODO(verify): checked in stellar-base 13.1.0 (build() fee = base fee x ops, ext = sorobanData);
    // re-check that the pinned SDK's builder still does not fold the resource fee into the inner fee.
    const acct2 = await this.server.getAccount(payer.publicKey());
    const inner = new TransactionBuilder(acct2, { fee: '100', networkPassphrase: this.cfg.passphrase })
      .addOperation(Operation.uploadContractWasm({ wasm }))
      .setSorobanData(sim.transactionData.build())
      .setTimeout(300)
      .build();
    inner.sign(payer);
    const outerFee = (BigInt(sim.minResourceFee) + 10_000_000n).toString();
    const fb = TransactionBuilder.buildFeeBumpTransaction(payer, outerFee, inner, this.cfg.passphrase);
    const r = await this.send(`${label} (fee-bump upload, min resource fee ${sim.minResourceFee})`, fb, [payer]);
    if (r.status !== 'SUCCESS') throw new Error(`${label}: upload ${r.status}`);
    return hash;
  }

  /** Deploys a contract from an uploaded Wasm hash, with constructor arguments. Returns its C-address. */
  async deployContract(label: string, deployer: Keypair, wasmHashHex: string, constructorArgs: xdr.ScVal[] = []): Promise<string> {
    const acct = await this.server.getAccount(deployer.publicKey());
    const op = Operation.createCustomContract({
      address: Address.fromString(deployer.publicKey()),
      wasmHash: Buffer.from(wasmHashHex, 'hex'),
      constructorArgs,
      salt: randomBytes(32),
    });
    const tx0 = new TransactionBuilder(acct, { fee: CONTRACT_BASE_FEE, networkPassphrase: this.cfg.passphrase }).addOperation(op).setTimeout(300).build();
    const sim = await this.server.simulateTransaction(tx0);
    if (rpc.Api.isSimulationError(sim)) throw new Error(`${label}: ${simCost(sim).error}`);
    const r = await this.send(label, rpc.assembleTransaction(tx0, sim).build(), [deployer]);
    if (r.status !== 'SUCCESS' || !r.returnValue) throw new Error(`${label}: ${r.status}`);
    return scValToNative(r.returnValue) as string;
  }

  /** Deploys the Stellar Asset Contract for a classic asset, or returns the existing one. */
  async deploySac(label: string, asset: Asset, deployer: Keypair): Promise<string> {
    const id = asset.contractId(this.cfg.passphrase);
    const acct = await this.server.getAccount(deployer.publicKey());
    const tx0 = new TransactionBuilder(acct, { fee: CONTRACT_BASE_FEE, networkPassphrase: this.cfg.passphrase })
      .addOperation(Operation.createStellarAssetContract({ asset }))
      .setTimeout(300)
      .build();
    const sim = await this.server.simulateTransaction(tx0);
    if (rpc.Api.isSimulationError(sim)) {
      this.note(`${label}: SAC already deployed`, { id });
      return id;
    }
    const r = await this.send(label, rpc.assembleTransaction(tx0, sim).build(), [deployer]);
    if (r.status !== 'SUCCESS') throw new Error(`${label}: ${r.status}`);
    return id;
  }

  /** Token balance through the SAC. */
  async balance(sac: string, account: string, source: string): Promise<bigint> {
    return BigInt(await this.readNative<bigint>(sac, 'balance', [new Address(account).toScVal()], source));
  }
}

export const isRefusal = (r: unknown): r is Refusal => typeof r === 'object' && r !== null && 'refused' in r;
export const isTx = (r: unknown): r is TxResult => typeof r === 'object' && r !== null && 'hash' in r && 'status' in r;

