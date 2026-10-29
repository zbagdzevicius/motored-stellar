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
  SorobanDataBuilder,
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
  errors?: string[];
}

export interface TxResult extends TxRecord {
  returnValue?: xdr.ScVal;
  /** For a FAILED transaction: the contract errors the ledger recorded in its diagnostic events, e.g. "Error(Contract, #15) BadFeeAddr". */
  errors?: string[];
}

/** A refused call that was landed on chain on purpose and failed there with the guard's error. */
export interface LandedRefusal extends TxResult {
  /** The guard error code the enforce-mode simulation predicted before submission. */
  expectedCode: number;
  /** True when the ledger's own diagnostic events carry Error(Contract, #expectedCode). */
  confirmed: boolean;
}

/** The accepted alternative on the same escrow, simulated only, whose footprint covers the guard's reads. */
export interface AcceptedSibling {
  args: xdr.ScVal[];
  key: Keypair;
  branch: GuardBranch;
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
  const r = sim.transactionData.build().resources;
  return { instructions: r.instructions, minResourceFee: sim.minResourceFee };
}

/** ScVal for a guard signature in the given branch. */
export function guardSignature(branch: GuardBranch, sig: Buffer): xdr.ScVal {
  if (branch.kind === 'ResolveSeller') return variant('ResolveSeller', map({ claim: claimToScVal(branch.claim), sig: bytes(sig) }));
  return variant(branch.kind, bytes(sig));
}

const keyId = (k: xdr.LedgerKey): string => k.toXdr('base64');

/**
 * Union of Soroban footprints. A key that any input writes stays read-write and is
 * dropped from the read-only set (a key may not appear in both).
 */
export function mergeFootprints(fps: xdr.LedgerFootprint[]): { readOnly: xdr.LedgerKey[]; readWrite: xdr.LedgerKey[] } {
  const rw = new Map<string, xdr.LedgerKey>();
  const ro = new Map<string, xdr.LedgerKey>();
  for (const fp of fps) for (const k of fp.readWrite) rw.set(keyId(k), k);
  for (const fp of fps) for (const k of fp.readOnly) if (!rw.has(keyId(k))) ro.set(keyId(k), k);
  return { readOnly: [...ro.values()], readWrite: [...rw.values()] };
}

/** Contract error codes found in diagnostic events (topics or data), in order, de-duplicated. */
export function contractErrorCodes(events: xdr.DiagnosticEvent[] | undefined): number[] {
  const out: number[] = [];
  const visit = (v: xdr.ScVal): void => {
    if (v.type === 'scvError' && v.error.type === 'sceContract') {
      const c = v.error.contractCode;
      if (!out.includes(c)) out.push(c);
    } else if (v.type === 'scvVec') for (const x of v.vec ?? []) visit(x);
  };
  for (const d of events ?? []) {
    const body = d.event.body.v0;
    for (const t of body.topics) visit(t);
    visit(body.data);
  }
  return out;
}

/** "Error(Contract, #N) Name" for a guard error code. */
export const guardErrorLabel = (code: number): string => `Error(Contract, #${code})${GUARD_ERRORS[code] ? ` ${GUARD_ERRORS[code]}` : ''}`;

/** Diagnostic events of a landed transaction, from the RPC field or, failing that, the v4 meta. */
function diagnosticEventsOf(g: rpc.Api.GetFailedTransactionResponse | rpc.Api.GetSuccessfulTransactionResponse): xdr.DiagnosticEvent[] {
  if (g.diagnosticEventsXdr && g.diagnosticEventsXdr.length > 0) return g.diagnosticEventsXdr;
  try {
    const m = g.resultMetaXdr;
    if (m.type === 'v4') return m.v4.diagnosticEvents;
    if (m.type === 'v3') return m.v3.sorobanMeta?.diagnosticEvents ?? [];
  } catch {
    // Unknown meta shape: no events.
  }
  return [];
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
    this.runLog.push({ label: r.label, hash: r.hash, status: r.status, link: r.link, ...(r.errors ? { errors: r.errors } : {}) });
    this.print(`== ${r.label}: ${r.status}${r.errors?.length ? ` [${r.errors.join('; ')}]` : ''} ${r.link}`);
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
    const op = auth
      ? Operation.invokeContractFunction({ contract: contractId, function: fn, args, auth })
      : new Contract(contractId).call(fn, ...args);
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
      if (g.status === rpc.Api.GetTransactionStatus.FAILED) {
        const errors = contractErrorCodes(diagnosticEventsOf(g)).map(guardErrorLabel);
        return this.record({ label, hash: r.hash, status: 'FAILED', link, errors });
      }
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
   * Verified 29 Oct 2026 on @stellar/stellar-sdk 17.4 against testnet RPC: a read of the run 4
   * guard's `registration` with a random, never-funded source simulates fine.
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
    const creds = xdr.expectUnionVariant(entry.credentials, 'sorobanCredentialsAddress').address;
    const signatureExpirationLedger = latest + 200;
    const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
      new xdr.HashIdPreimageSorobanAuthorization({
        networkId: sha256(Buffer.from(this.cfg.passphrase)),
        nonce: creds.nonce,
        signatureExpirationLedger,
        invocation: entry.rootInvocation,
      }),
    );
    // XDR values are immutable since stellar-sdk 17: build a signed copy.
    return new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
        new xdr.SorobanAddressCredentials({
          address: creds.address,
          nonce: creds.nonce,
          signatureExpirationLedger,
          signature: guardSignature(branch, Buffer.from(key.sign(sha256(preimage.toXdr())))),
        }),
      ),
      rootInvocation: entry.rootInvocation,
    });
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
    // authMode 'enforce' verified in runs 4-6 (28-29 Oct 2026) on @stellar/stellar-sdk 17.4: refusals fail here with the guard's error code.
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

  /**
   * Lands a call the guard refuses, so the refusal is a FAILED transaction on the ledger
   * rather than a local simulation. Never submits a call the guard would accept:
   *
   * 1. record-mode simulation of the refused call, sign the guard's auth entry with `key`;
   * 2. enforce-mode simulation must fail with `expectCode` (if it passes, or fails with any
   *    other error, nothing is submitted and a refusal is returned);
   * 3. the accepted alternative on the same escrow (`accepted`) is simulated in enforce mode,
   *    never submitted. A failed simulation returns no footprint, and the record-mode one
   *    does not cover the guard's own `__check_auth` reads; the accepted path reads the same
   *    guard config and per-escrow record, so the union of the two footprints covers every
   *    entry the refused call touches before the guard rejects it;
   * 4. the refused call is submitted with that union footprint, the accepted path's resources
   *    plus headroom and a resource fee above its minimum, so validators include it and it
   *    fails in the host with the guard's error;
   * 5. the error is read back from the ledger's diagnostic events (`confirmed`).
   */
  async landRefusal(
    label: string,
    submitter: Keypair,
    escrow: string,
    fn: string,
    args: xdr.ScVal[],
    key: Keypair,
    branch: GuardBranch,
    expectCode: number,
    accepted: AcceptedSibling,
  ): Promise<LandedRefusal | Refusal> {
    const rec = await this.server.simulateTransaction(await this.contractTx(submitter.publicKey(), escrow, fn, args));
    if (rpc.Api.isSimulationError(rec)) return this.refuse(`${label} (record-sim)`, simCost(rec).error ?? 'error');
    if (!rpc.Api.isSimulationSuccess(rec) || !rec.result || rec.result.auth.length === 0 || !rec.transactionData) return this.refuse(label, 'no auth entry to sign');
    const signed = await this.signGuardEntry(rec.result.auth[0] as xdr.SorobanAuthorizationEntry, key, branch);
    const tx1 = await this.contractTx(submitter.publicKey(), escrow, fn, args, [signed]);
    const enf = await this.server.simulateTransaction(tx1, undefined, 'enforce');
    if (!rpc.Api.isSimulationError(enf)) return this.refuse(label, `enforce-sim PASSES: not submitted (expected ${guardErrorLabel(expectCode)})`);
    const m = enf.error.match(/Error\(Contract, #(\d+)\)/);
    if (!m || Number(m[1]) !== expectCode) return this.refuse(label, `expected ${guardErrorLabel(expectCode)}, simulation said ${simCost(enf).error}; not submitted`);

    const rec2 = await this.server.simulateTransaction(await this.contractTx(submitter.publicKey(), escrow, fn, accepted.args));
    if (!rpc.Api.isSimulationSuccess(rec2) || !rec2.result || rec2.result.auth.length === 0) return this.refuse(label, 'accepted sibling: record-sim failed');
    const signed2 = await this.signGuardEntry(rec2.result.auth[0] as xdr.SorobanAuthorizationEntry, accepted.key, accepted.branch);
    const enf2 = await this.server.simulateTransaction(await this.contractTx(submitter.publicKey(), escrow, fn, accepted.args, [signed2]), undefined, 'enforce');
    if (!rpc.Api.isSimulationSuccess(enf2) || !enf2.transactionData) return this.refuse(label, `accepted sibling: enforce-sim ${simCost(enf2).error ?? 'no data'}`);

    const sib = enf2.transactionData.build();
    const fp = mergeFootprints([rec.transactionData.build().resources.footprint, sib.resources.footprint]);
    const res = sib.resources;
    const instructions = Math.min(Math.ceil(res.instructions * 1.5) + 2_000_000, 400_000_000);
    const resourceFee = BigInt(enf2.minResourceFee) * 2n + 10_000_000n;
    const data = new SorobanDataBuilder()
      .setFootprint(fp.readOnly, fp.readWrite)
      .setResources(instructions, res.diskReadBytes + 20_000, res.writeBytes + 5_000)
      .setResourceFee(resourceFee)
      .build();
    this.note(`${label}: enforce-sim refuses with ${guardErrorLabel(expectCode)}; landing it with a manual footprint`, {
      readOnly: fp.readOnly.length, readWrite: fp.readWrite.length, instructions, resourceFee,
    });
    const acct = await this.server.getAccount(submitter.publicKey());
    const op = Operation.invokeContractFunction({ contract: escrow, function: fn, args, auth: [signed] });
    const tx = new TransactionBuilder(acct, { fee: CONTRACT_BASE_FEE, networkPassphrase: this.cfg.passphrase }).addOperation(op).setSorobanData(data).setTimeout(300).build();
    const r = await this.send(label, tx, [submitter]);
    const confirmed = r.status === 'FAILED' && (r.errors ?? []).some((e) => e.startsWith(`Error(Contract, #${expectCode})`));
    return { ...r, expectedCode: expectCode, confirmed };
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
    // Verified in run 4 (28 Oct 2026) on @stellar/stellar-sdk 17.4: both fee-bump uploads landed with
    // this inner fee (docs/testnet-proofs.md, Run 4); the builder does not fold the resource fee into it.
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

