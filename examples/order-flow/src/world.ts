// SPDX-License-Identifier: Apache-2.0
//
// The in-memory "world" the example runs in: one platform, its guard and claim
// registry, a Trustless Work escrow model, wallets, an EURC ledger and the
// reconciler's view of the chain. Every piece is a port implementation from the
// packages in this repository; nothing here talks to a network.
//
// How the pieces connect:
//
//   OrderSource ──► EscrowLifecycle ──► RecordingEscrowApi ──► InMemoryEscrowApi
//                        │                     │ (every landed tx)
//                        │                     ▼
//                        │              InMemoryChainReader  ◄── reconciler runOnce
//                        ▼
//                   GuardModel  ◄── InMemoryRegistry ◄── ClaimAnchoringJob ◄── DeliveryOracle
//
// The EURC "ledger" is the chain reader's transfer list: balances are derived
// from transfers, exactly as the reconciler reads them on a real network.

import { createHash, randomBytes } from 'node:crypto';
import { Account, Asset, Keypair, Networks, Operation, StrKey, TransactionBuilder } from '@stellar/stellar-sdk';
import * as claims from '@motored-stellar/claims';
import * as escrow from '@motored-stellar/escrow';
import * as recon from '@motored-stellar/reconciler';
import { KeypairWallet, hasValidSignatureFrom, type TransactionSummary } from '@motored-stellar/wallets';
import { GuardModel } from './guard-model.js';

/** One clock for every package: seconds for escrow and claims, milliseconds for the reconciler. */
export class SimClock implements escrow.Clock, claims.Clock, recon.Clock {
  constructor(private t: number) {}
  nowSeconds(): number {
    return this.t;
  }
  now(): number {
    return this.t * 1000;
  }
  advance(seconds: number): void {
    this.t += seconds;
  }
}

/** A landed transaction, for the run log. */
export interface TxRecord {
  txHash: string;
  label: string;
  at: number;
}

type CallKind =
  | 'deploy'
  | 'fund_escrow'
  | 'approve_milestone'
  | 'dispute_escrow'
  | 'release_funds'
  | 'resolve_dispute'
  | 'update_escrow';

/**
 * EscrowApi decorator: forwards every call to the in-memory Trustless Work model
 * and, when a transaction lands, writes its EURC movements into the chain reader
 * with the transaction hash, the way SAC `transfer` events would show them.
 */
export class RecordingEscrowApi implements escrow.EscrowApi, escrow.FundingHistory {
  readonly log: TxRecord[] = [];
  private readonly kinds = new Map<string, CallKind>();
  private readonly funds = new Map<string, escrow.FundEscrowRequest>();

  constructor(
    readonly inner: escrow.InMemoryEscrowApi,
    private readonly chain: recon.InMemoryChainReader,
    private readonly clock: SimClock,
  ) {}

  /** Hash of the most recent landed transaction. */
  get lastTx(): string {
    const last = this.log.at(-1);
    if (!last) throw new Error('no transaction has landed yet');
    return last.txHash;
  }

  async initialize(req: escrow.InitializeEscrowRequest): Promise<escrow.UnsignedTx> {
    return this.track('deploy', await this.inner.initialize(req));
  }
  async fund(req: escrow.FundEscrowRequest): Promise<escrow.UnsignedTx> {
    const tx = await this.inner.fund(req);
    this.funds.set(tx.unsignedXdr, req);
    return this.track('fund_escrow', tx);
  }
  async approve(req: escrow.ApproveMilestoneRequest): Promise<escrow.UnsignedTx> {
    return this.track('approve_milestone', await this.inner.approve(req));
  }
  async changeDisputeFlag(req: escrow.DisputeEscrowRequest): Promise<escrow.UnsignedTx> {
    return this.track('dispute_escrow', await this.inner.changeDisputeFlag(req));
  }
  async release(req: escrow.ReleaseFundsRequest): Promise<escrow.UnsignedTx> {
    return this.track('release_funds', await this.inner.release(req));
  }
  async resolve(req: escrow.ResolveDisputeRequest): Promise<escrow.UnsignedTx> {
    return this.track('resolve_dispute', await this.inner.resolve(req));
  }
  async updateEscrow(req: escrow.UpdateEscrowRequest): Promise<escrow.UnsignedTx> {
    return this.track('update_escrow', await this.inner.updateEscrow(req));
  }
  getEscrow(contractId: string): Promise<escrow.EscrowSnapshot> {
    return this.inner.getEscrow(contractId);
  }
  fundings(contractId: string): Promise<escrow.FundRecord[]> {
    return this.inner.fundings(contractId);
  }

  async sendTransaction(signedXdr: string): Promise<escrow.SendResult> {
    const before = this.inner.transfers.length;
    const result = await this.inner.sendTransaction(signedXdr);
    const txHash = result.txHash ?? sha256Hex(signedXdr);
    const closedAt = this.clock.now();
    const fund = this.funds.get(signedXdr);
    if (fund) this.chain.transfer({ txHash, closedAt, from: fund.signer, to: fund.contractId, amount: fund.amount });
    for (const t of this.inner.transfers.slice(before)) this.chain.transfer({ txHash, closedAt, ...t });
    this.log.push({ txHash, label: this.kinds.get(signedXdr) ?? 'tx', at: this.clock.nowSeconds() });
    this.funds.delete(signedXdr);
    this.kinds.delete(signedXdr);
    return { ...result, txHash };
  }

  private track(kind: CallKind, tx: escrow.UnsignedTx): escrow.UnsignedTx {
    this.kinds.set(tx.unsignedXdr, kind);
    return tx;
  }
}

/**
 * An escrow `Signer` backed by a user's wallet (`WalletProvider` from
 * @motored-stellar/wallets). Users sign whole transactions, never raw hashes for
 * the platform, so only the `walletSignXdr` path below uses it.
 */
export class WalletSigner implements escrow.Signer {
  /** What the user was shown before each signature (the decoded transaction). */
  readonly reviewed: TransactionSummary[] = [];
  readonly wallet: KeypairWallet;

  constructor(readonly label: string) {
    this.wallet = KeypairWallet.random({
      networkPassphrase: Networks.TESTNET,
      beforeSign: (summary) => {
        this.reviewed.push(summary);
        return true;
      },
    });
  }
  publicKey(): string {
    return this.wallet.publicKey;
  }
  rawPublicKey(): Uint8Array {
    return StrKey.decodeEd25519PublicKey(this.wallet.publicKey);
  }
  async signTxHash(): Promise<Uint8Array> {
    throw new Error('user wallets sign transactions through the wallet provider, not raw hashes');
  }
  async signAuthPayload(): Promise<Uint8Array> {
    throw new Error('user wallets sign transactions through the wallet provider, not raw payloads');
  }
}

/**
 * `SignXdr` for the in-memory model. In-memory transactions are opaque tokens,
 * so for a user's wallet this wraps the token in a real (never submitted) Stellar
 * transaction, runs it through the wallet's review hook and signature, and checks
 * the signature, which is the same path a Privy or Wallets Kit signature takes.
 * Platform keys sign the token as-is.
 */
export const walletSignXdr: escrow.SignXdr = async (unsignedXdr, signer) => {
  if (!(signer instanceof WalletSigner)) return escrow.passthroughSignXdr(unsignedXdr, signer);
  const tx = new TransactionBuilder(new Account(signer.publicKey(), '0'), { fee: '100', networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.manageData({ name: 'in-memory-call', value: unsignedXdr }))
    .setTimeout(300)
    .build();
  const signed = await signer.wallet.signTransaction(tx);
  if (!hasValidSignatureFrom(signed, signer.publicKey())) throw new Error(`${signer.label} wallet signature did not verify`);
  return unsignedXdr;
};

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

const DAY = 86_400;

export interface World {
  clock: SimClock;
  keys: {
    platform: escrow.KeypairSigner;
    release: escrow.KeypairSigner;
    resolver: escrow.KeypairSigner;
    breakGlass: escrow.KeypairSigner;
  };
  /** Circle's issuer stand-in: mints EURC into buyer wallets (an on-ramp in real life). */
  issuer: string;
  trustlessWorkFee: string;
  guardAddress: string;
  tokenContractId: string;
  api: RecordingEscrowApi;
  lifecycle: escrow.EscrowLifecycle;
  orders: escrow.InMemoryOrderSource;
  guard: GuardModel;
  registry: claims.InMemoryRegistry;
  oracle: claims.InMemoryDeliveryOracle;
  anchoring: claims.ClaimAnchoringJob;
  chain: recon.InMemoryChainReader;
  ledger: recon.InMemoryLedgerSource;
  reconConfig: recon.ReconcilerConfig;
  reports: recon.InMemoryReportSink;
}

/** Builds a fresh world. Every key is created at runtime and never leaves this process. */
export function buildWorld(start = 1_800_000_000): World {
  const clock = new SimClock(start);
  const keys = {
    platform: escrow.KeypairSigner.random(),
    release: escrow.KeypairSigner.random(),
    resolver: escrow.KeypairSigner.random(),
    breakGlass: escrow.KeypairSigner.random(),
  };
  const issuer = Keypair.random().publicKey();
  const trustlessWorkFee = Keypair.random().publicKey();
  const guardAddress = StrKey.encodeContract(randomBytes(32));
  const tokenContractId = StrKey.encodeContract(randomBytes(32));

  const chain = new recon.InMemoryChainReader();
  const api = new RecordingEscrowApi(new escrow.InMemoryEscrowApi({ trustlessWorkFeeAddress: trustlessWorkFee }), chain, clock);
  const lifecycle = new escrow.EscrowLifecycle(api, walletSignXdr, api, {
    platform: keys.platform,
    guardAddress,
    tokenContractId,
    milestoneStatus: 'awaiting delivery',
  });

  const registry = new claims.InMemoryRegistry(clock);
  const oracle = new claims.InMemoryDeliveryOracle();
  const anchoring = new claims.ClaimAnchoringJob({
    oracle,
    salts: new claims.InMemorySaltStore(),
    registry,
    store: new claims.InMemoryClaimStore(),
    clock,
  });

  const guard = new GuardModel(
    {
      address: guardAddress,
      platform: keys.platform.publicKey(),
      releaseKey: keys.release.rawPublicKey(),
      resolverKey: keys.resolver.rawPublicKey(),
      breakGlassKey: keys.breakGlass.rawPublicKey(),
      delay: 7 * DAY,
      contestWindow: 7 * DAY,
    },
    registry,
    () => clock.nowSeconds(),
  );

  return {
    clock,
    keys,
    issuer,
    trustlessWorkFee,
    guardAddress,
    tokenContractId,
    api,
    lifecycle,
    orders: new escrow.InMemoryOrderSource(),
    guard,
    registry,
    oracle,
    anchoring,
    chain,
    ledger: new recon.InMemoryLedgerSource(),
    reconConfig: recon.makeConfig({ platformAccount: keys.platform.publicKey(), trustlessWorkFeeAccount: trustlessWorkFee }),
    reports: new recon.InMemoryReportSink(),
  };
}

/** EURC balance of any account or contract, from the transfer ledger. */
export async function balanceOf(w: World, holder: string): Promise<bigint> {
  return (await w.chain.getBalance(holder)).amount;
}

/**
 * The buyer's shipping payment in the funding step: a classic EURC payment to the
 * escrow's pinned platform address, outside the escrow, built by
 * `buildShippingPaymentTransaction` as the transaction after `fund_escrow`, reviewed
 * and signed in the buyer's wallet, then recorded as a transfer. Returns its hash.
 */
export async function payShipping(w: World, buyer: WalletSigner, contractId: string, amount: bigint): Promise<string> {
  const platform = (await w.api.getEscrow(contractId)).roles.platform;
  const { tx } = escrow.buildShippingPaymentTransaction(
    Networks.TESTNET,
    { source: buyer.publicKey(), sequence: '1' },
    platform,
    { asset: new Asset('EURC', w.issuer), amount },
  );
  const signed = await buyer.wallet.signTransaction(tx);
  if (!hasValidSignatureFrom(signed, buyer.publicKey())) throw new Error('buyer wallet signature did not verify');
  const txHash = Buffer.from(signed.hash()).toString('hex');
  w.chain.transfer({ txHash, closedAt: w.clock.now(), from: buyer.publicKey(), to: platform, amount });
  w.api.log.push({ txHash, label: 'shipping_payment', at: w.clock.nowSeconds() });
  return txHash;
}

/** Credits EURC to a wallet (stands in for a SEPA on-ramp or an exchange withdrawal). */
export function mintEurc(w: World, to: string, amount: bigint): void {
  w.chain.transfer({ txHash: sha256Hex(`mint/${to}/${amount}/${w.clock.now()}`), closedAt: w.clock.now(), from: w.issuer, to, amount });
}

/** Mirrors the on-chain escrow into the reconciler's chain reader. */
export async function syncEscrowState(w: World, contractId: string): Promise<void> {
  const s = await w.api.getEscrow(contractId);
  w.chain.putEscrow(contractId, {
    amount: s.amount,
    platformFeeBps: s.platformFeeBps,
    approver: s.roles.approver,
    receiver: s.roles.receiver,
    platform: s.roles.platform,
    flags: { ...s.flags },
    milestoneApproved: s.milestones.length > 0 && s.milestones.every((m) => m.approved),
  });
}
