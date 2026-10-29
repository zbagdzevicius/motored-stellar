// SPDX-License-Identifier: Apache-2.0
//
// Ports: the small typed interfaces through which a marketplace's own systems
// (order database, carrier integration, key custody, ledger, reporting) plug into
// the escrow rail. Every port ships an in-memory implementation used by the tests
// and by examples/order-flow. Real adapters live next to their dependency:
// RPC-backed ones in ./adapters, the Trustless Work REST client in ./tw-rest.ts,
// EURC, wallet and ramp adapters in the sibling packages.

import { createHash } from 'node:crypto';
import { Account, Address, Keypair, type FeeBumpTransaction, type Transaction, type xdr } from '@stellar/stellar-sdk';
import type { EscrowSnapshot, OnChainEscrow } from './escrow-types.js';

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

export interface Clock {
  /** Unix time in seconds. */
  nowSeconds(): number;
}

export const systemClock: Clock = { nowSeconds: () => Math.floor(Date.now() / 1000) };

/** A clock tests can move. */
export class ManualClock implements Clock {
  constructor(private t = 1_800_000_000) {}
  nowSeconds(): number {
    return this.t;
  }
  advance(seconds: number): void {
    this.t += seconds;
  }
}

// ---------------------------------------------------------------------------
// Signer and KeyStore
// ---------------------------------------------------------------------------

/**
 * Anything that can produce raw ed25519 signatures for one Stellar key: a runtime
 * test key, a KMS or HSM key, or a user's wallet with raw-hash signing.
 * Guard keys (release, resolver, break-glass) are plain ed25519 keys whose
 * 32-byte public key is pinned in the guard; they sign Soroban authorization
 * payloads, never transaction envelopes.
 */
export interface Signer {
  /** G... address of the key. */
  publicKey(): string;
  /** Raw 32-byte ed25519 public key (what the guard stores). */
  rawPublicKey(): Uint8Array;
  /** Signs a 32-byte transaction hash; returns a 64-byte signature. */
  signTxHash(hash: Uint8Array): Promise<Uint8Array>;
  /** Signs a 32-byte Soroban authorization payload; returns a 64-byte signature. */
  signAuthPayload(payload: Uint8Array): Promise<Uint8Array>;
}

/**
 * Signer over an in-process `Keypair`. Intended for tests, the example and testnet
 * scripts, where keys are created at runtime with `Keypair.random()`. It never
 * reads keys from the environment or from disk.
 */
export class KeypairSigner implements Signer {
  constructor(private readonly kp: Keypair) {}
  static random(): KeypairSigner {
    return new KeypairSigner(Keypair.random());
  }
  publicKey(): string {
    return this.kp.publicKey();
  }
  rawPublicKey(): Uint8Array {
    return this.kp.rawPublicKey();
  }
  async signTxHash(hash: Uint8Array): Promise<Uint8Array> {
    return this.kp.sign(Buffer.from(hash));
  }
  async signAuthPayload(payload: Uint8Array): Promise<Uint8Array> {
    return this.kp.sign(Buffer.from(payload));
  }
}

/** Named signers (release, resolver, break-glass, platform, sponsor, ...). */
export interface KeyStore {
  get(name: string): Promise<Signer>;
}

export class InMemoryKeyStore implements KeyStore {
  private readonly keys = new Map<string, Signer>();
  set(name: string, signer: Signer): this {
    this.keys.set(name, signer);
    return this;
  }
  /** Creates a fresh runtime key on first use. */
  async get(name: string): Promise<Signer> {
    let s = this.keys.get(name);
    if (!s) {
      s = KeypairSigner.random();
      this.keys.set(name, s);
    }
    return s;
  }
}

// ---------------------------------------------------------------------------
// Submitter (Soroban RPC)
// ---------------------------------------------------------------------------

export type AuthMode = 'enforce' | 'record' | 'record_allow_nonroot';

export type SimulationOutcome =
  | {
      ok: true;
      retval?: xdr.ScVal;
      /** Authorization entries the host recorded (record mode) or validated. */
      auth: xdr.SorobanAuthorizationEntry[];
      minResourceFee: bigint;
      /** Applies the simulated footprint and resource fee to the transaction. */
      prepare(tx: Transaction): Transaction;
    }
  | { ok: false; error: string; contractErrorCode?: number };

export interface SubmitResult {
  hash: string;
  status: 'SUCCESS' | 'FAILED' | 'REJECTED' | 'TIMEOUT';
  returnValue?: xdr.ScVal;
  feeCharged?: bigint;
}

/** Reads accounts, simulates and submits transactions. */
export interface Submitter {
  getAccount(publicKey: string): Promise<Account>;
  getLatestLedger(): Promise<number>;
  simulate(tx: Transaction, authMode?: AuthMode): Promise<SimulationOutcome>;
  send(tx: Transaction | FeeBumpTransaction): Promise<SubmitResult>;
}

/** Handler for one contract function in `InMemorySubmitter`. */
export type SimHandler = (args: xdr.ScVal[], tx: Transaction, authMode: AuthMode) => SimulationOutcome;

/**
 * Programmable submitter for unit tests: register a simulation result per
 * `contractId.fn`; submitted transactions are recorded, not executed.
 */
export class InMemorySubmitter implements Submitter {
  readonly sent: Array<Transaction | FeeBumpTransaction> = [];
  readonly simulated: Array<{ tx: Transaction; authMode: AuthMode }> = [];
  private readonly handlers = new Map<string, SimHandler>();
  private readonly accounts = new Map<string, bigint>();
  constructor(public ledger = 1_000) {}

  on(contractId: string, fn: string, handler: SimHandler): this {
    this.handlers.set(`${contractId}.${fn}`, handler);
    return this;
  }
  async getAccount(publicKey: string): Promise<Account> {
    const seq = this.accounts.get(publicKey) ?? 1n;
    return new Account(publicKey, seq.toString());
  }
  async getLatestLedger(): Promise<number> {
    return this.ledger;
  }
  async simulate(tx: Transaction, authMode: AuthMode = 'record'): Promise<SimulationOutcome> {
    this.simulated.push({ tx, authMode });
    const op = tx.operations[0];
    if (!op || op.type !== 'invokeHostFunction') return { ok: false, error: 'not an invokeHostFunction transaction' };
    const fn = op.func;
    if (fn.type !== 'hostFunctionTypeInvokeContract') return { ok: false, error: 'not a contract call' };
    const call = fn.invokeContract;
    const contractId = Address.fromScAddress(call.contractAddress).toString();
    const name = call.functionName.toString();
    const h = this.handlers.get(`${contractId}.${name}`);
    if (!h) return { ok: false, error: `no in-memory handler for ${contractId}.${name}` };
    return h(call.args, tx, authMode);
  }
  async send(tx: Transaction | FeeBumpTransaction): Promise<SubmitResult> {
    this.sent.push(tx);
    const inner = 'innerTransaction' in tx ? tx.innerTransaction : tx;
    this.accounts.set(inner.source, BigInt(inner.sequence));
    return { hash: Buffer.from(tx.hash()).toString('hex'), status: 'SUCCESS' };
  }
}

/** A successful simulation result for `InMemorySubmitter` handlers. */
export function simOk(retval?: xdr.ScVal, auth: xdr.SorobanAuthorizationEntry[] = []): SimulationOutcome {
  return { ok: true, retval, auth, minResourceFee: 100_000n, prepare: (tx) => tx };
}

/** A failed simulation result carrying a contract error code. */
export function simContractError(code: number): SimulationOutcome {
  return { ok: false, error: `HostError: Error(Contract, #${code})`, contractErrorCode: code };
}

// ---------------------------------------------------------------------------
// EventSource (Soroban RPC getEvents or an indexer)
// ---------------------------------------------------------------------------

/** One contract event in Soroban RPC's JSON shape (topics and value as base64 XDR). */
export interface RawContractEvent {
  id: string;
  ledger: number;
  ledgerClosedAt: string;
  contractId: string;
  txHash: string;
  topic: string[];
  value: string;
  inSuccessfulContractCall?: boolean;
}

export interface EventQuery {
  contractIds: string[];
  /**
   * Topic filters in RPC form: each filter is a list of base64 ScVals or "*"
   * (any single segment). An event matches if any filter matches.
   */
  topics?: string[][];
  startLedger?: number;
  cursor?: string;
  limit?: number;
}

export interface EventPage {
  events: RawContractEvent[];
  /** Pass back as `cursor` to continue after the last event. */
  cursor?: string;
  latestLedger?: number;
}

export interface EventSource {
  getEvents(q: EventQuery): Promise<EventPage>;
}

/** True when `event` matches an RPC-style topic filter. */
export function topicMatches(event: RawContractEvent, filter: string[]): boolean {
  if (filter.length > event.topic.length) return false;
  if (filter.length < event.topic.length && filter[filter.length - 1] !== '**') return false;
  return filter.every((seg, i) => seg === '*' || seg === '**' || seg === event.topic[i]);
}

/** Event source over a fixed list, for example a committed `getEvents` response. */
export class InMemoryEventSource implements EventSource {
  private readonly events: RawContractEvent[];
  constructor(events: RawContractEvent[] = []) {
    this.events = [...events].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
  /** Builds a source from a JSON-RPC `getEvents` response (`{ result: { events } }`) or its `result`. */
  static fromRpcResponse(json: unknown): InMemoryEventSource {
    const j = json as { result?: { events?: RawContractEvent[] }; events?: RawContractEvent[] };
    return new InMemoryEventSource(j.result?.events ?? j.events ?? []);
  }
  push(...events: RawContractEvent[]): void {
    this.events.push(...events);
    this.events.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
  async getEvents(q: EventQuery): Promise<EventPage> {
    const ids = new Set(q.contractIds);
    const limit = q.limit ?? 100;
    const out = this.events.filter(
      (e) =>
        ids.has(e.contractId) &&
        (q.cursor === undefined ? e.ledger >= (q.startLedger ?? 0) : e.id > q.cursor) &&
        (!q.topics || q.topics.length === 0 || q.topics.some((f) => topicMatches(e, f))),
    );
    const page = out.slice(0, limit);
    const last = page[page.length - 1];
    return { events: page, cursor: last ? last.id : q.cursor, latestLedger: this.events.at(-1)?.ledger };
  }
}

// ---------------------------------------------------------------------------
// EscrowApi (Trustless Work REST, or an in-memory model of the v1 contract)
// ---------------------------------------------------------------------------

/** An unsigned transaction (base64 envelope XDR) to sign and submit. */
export interface UnsignedTx {
  unsignedXdr: string;
}

export interface SendResult {
  status: 'SUCCESS' | 'FAILED';
  message?: string;
  /** Present when the submitted transaction deployed an escrow. */
  contractId?: string;
  txHash?: string;
}

export interface InitializeEscrowRequest {
  /** Account that signs the deploy transaction (the platform or sponsor account). */
  signer: string;
  escrow: Omit<OnChainEscrow, 'flags'>;
  /** Asset code shown by Trustless Work, e.g. "EURC". */
  trustlineSymbol: string;
}

export interface FundEscrowRequest {
  contractId: string;
  signer: string;
  amount: bigint;
}

export interface ApproveMilestoneRequest {
  contractId: string;
  milestoneIndex: number;
  approver: string;
}

export interface DisputeEscrowRequest {
  contractId: string;
  signer: string;
}

export interface ReleaseFundsRequest {
  contractId: string;
  releaseSigner: string;
}

export interface ResolveDisputeRequest {
  contractId: string;
  disputeResolver: string;
  distributions: Array<[string, bigint]>;
}

export interface UpdateEscrowRequest {
  contractId: string;
  signer: string;
  escrow: OnChainEscrow;
}

/**
 * The escrow operations a marketplace needs from Trustless Work. Each call returns
 * an unsigned transaction; the caller signs it with the right party's key and
 * hands it to `sendTransaction`. Release and resolution of guard-held escrows are
 * built by the release service instead (the API's unsigned-XDR flow for G-account
 * signers does not build the guard's Soroban auth entry).
 */
export interface EscrowApi {
  initialize(req: InitializeEscrowRequest): Promise<UnsignedTx>;
  fund(req: FundEscrowRequest): Promise<UnsignedTx>;
  approve(req: ApproveMilestoneRequest): Promise<UnsignedTx>;
  changeDisputeFlag(req: DisputeEscrowRequest): Promise<UnsignedTx>;
  release(req: ReleaseFundsRequest): Promise<UnsignedTx>;
  resolve(req: ResolveDisputeRequest): Promise<UnsignedTx>;
  updateEscrow(req: UpdateEscrowRequest): Promise<UnsignedTx>;
  getEscrow(contractId: string): Promise<EscrowSnapshot>;
  sendTransaction(signedXdr: string): Promise<SendResult>;
}

/** Signs an unsigned transaction XDR with a `Signer`. See `stellarSignXdr` for the real one. */
export type SignXdr = (unsignedXdr: string, signer: Signer) => Promise<string>;

/** One `fund_escrow` call seen on-chain. */
export interface FundRecord {
  signer: string;
  amount: bigint;
  txHash?: string;
  ledger?: number;
}

/** Funding history of an escrow (decoded `tw_fund` events). */
export interface FundingHistory {
  fundings(contractId: string): Promise<FundRecord[]>;
}

// ---------------------------------------------------------------------------
// OrderSource and DeliveryOracle (the marketplace's order and carrier systems)
// ---------------------------------------------------------------------------

export interface EscrowOrder {
  /** Random 32-byte order reference, hex. Never a database ID. */
  orderRef: string;
  /** Buyer wallet (approver). */
  buyer: string;
  /** Seller wallet (service provider and receiver). */
  seller: string;
  /** Escrow amount, 7-decimal units. */
  amount: bigint;
  /** What the card rail would pay the seller, 7-decimal units. */
  cardNet: bigint;
}

export interface OrderSource {
  getOrder(orderRef: string): Promise<EscrowOrder | undefined>;
}

export class InMemoryOrderSource implements OrderSource {
  private readonly orders = new Map<string, EscrowOrder>();
  constructor(orders: EscrowOrder[] = []) {
    for (const o of orders) this.orders.set(o.orderRef, o);
  }
  add(order: EscrowOrder): this {
    this.orders.set(order.orderRef, order);
    return this;
  }
  async getOrder(orderRef: string): Promise<EscrowOrder | undefined> {
    return this.orders.get(orderRef);
  }
}

/** A carrier "delivered" event, already reduced to the claim leaf's inputs. */
export interface DeliveredEvent {
  orderRef: string;
  /** sha256 of the carrier's authenticated tracking event (hex, 32 bytes). */
  carrierEventRef: string;
  /** Unix seconds, as reported by the carrier. Not used for timing on-chain. */
  deliveredAt: number;
  /** HMAC-SHA256(per-order secret salt, parcel number), hex. */
  parcelsCommit: string;
}

export interface DeliveryOracle {
  deliveredSince(cursor?: string): Promise<{ events: DeliveredEvent[]; cursor?: string }>;
}

export class InMemoryDeliveryOracle implements DeliveryOracle {
  private readonly events: DeliveredEvent[] = [];
  record(e: DeliveredEvent): this {
    this.events.push(e);
    return this;
  }
  async deliveredSince(cursor?: string): Promise<{ events: DeliveredEvent[]; cursor?: string }> {
    const from = cursor ? Number(cursor) : 0;
    return { events: this.events.slice(from), cursor: String(this.events.length) };
  }
}

/** Salted parcel commitment helper for in-memory oracles and tests. */
export function sha256Hex(...parts: Array<string | Uint8Array>): string {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest('hex');
}

// ---------------------------------------------------------------------------
// Wallets and ramps (adapters in packages/wallets and packages/ramps)
// ---------------------------------------------------------------------------

/** Resolves a user's wallet as a `Signer` (embedded wallet or connected wallet). */
export interface WalletProvider {
  walletFor(userRef: string): Promise<Signer>;
}

export class InMemoryWalletProvider implements WalletProvider {
  private readonly wallets = new Map<string, Signer>();
  async walletFor(userRef: string): Promise<Signer> {
    let w = this.wallets.get(userRef);
    if (!w) {
      w = KeypairSigner.random();
      this.wallets.set(userRef, w);
    }
    return w;
  }
}

/** Where a user sends or receives fiat for EURC. Kept generic; see packages/ramps for the provider adapter. */
export interface RampProvider {
  /** Deposit instructions that end in EURC at `wallet`. */
  onRamp(userRef: string, wallet: string): Promise<{ reference: string; instructions: Record<string, string> }>;
  /** Destination for a seller's EURC cash-out. */
  offRampDestination(userRef: string): Promise<{ address: string; memo?: string }>;
}

export class InMemoryRampProvider implements RampProvider {
  async onRamp(userRef: string, wallet: string): Promise<{ reference: string; instructions: Record<string, string> }> {
    return { reference: `onramp-${userRef}`, instructions: { wallet } };
  }
  async offRampDestination(userRef: string): Promise<{ address: string; memo?: string }> {
    return { address: Keypair.random().publicKey(), memo: `offramp-${userRef}` };
  }
}

// ---------------------------------------------------------------------------
// LedgerSource and ReportSink (reconciliation)
// ---------------------------------------------------------------------------

/** What the marketplace's ledger expects for one escrow. */
export interface ExpectedEscrowLedger {
  contractId: string;
  amount: bigint;
  /** Expected on-chain balance right now. */
  expectedBalance: bigint;
  /** Refund top-ups the ledger says were sent, 7-decimal units. */
  topUps: bigint[];
}

export interface LedgerSource {
  openEscrows(): Promise<ExpectedEscrowLedger[]>;
}

export class InMemoryLedgerSource implements LedgerSource {
  constructor(public rows: ExpectedEscrowLedger[] = []) {}
  async openEscrows(): Promise<ExpectedEscrowLedger[]> {
    return this.rows;
  }
}

export interface ReportSink<T = unknown> {
  publish(report: T): Promise<void>;
}

export class InMemoryReportSink<T = unknown> implements ReportSink<T> {
  readonly reports: T[] = [];
  async publish(report: T): Promise<void> {
    this.reports.push(report);
  }
}
