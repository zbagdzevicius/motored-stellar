// SPDX-License-Identifier: Apache-2.0
//
// In-memory model of a Trustless Work v1 single-release escrow behind the
// EscrowApi port, for tests and the runnable example. It reproduces the contract
// rules the escrow rail depends on (see docs/architecture.md, "Behaviour we rely
// on"):
//
//  - `fund_escrow` accepts any positive amount from any signer, any number of
//    times, and fails if the escrow changed since the call was built
//    (`expected_escrow`);
//  - roles, amount, fee, trustline and existing milestones are frozen once the
//    balance is above zero; while funded the platform may only append milestones;
//  - release needs every milestone approved and no dispute, pays fees on
//    `escrow.amount` and leaves any excess in the escrow;
//  - a resolution needs an open dispute and a distribution that sums to the live
//    balance; fees are deducted per recipient;
//  - an empty milestone status can never be approved.
//
// The guard is not modelled: the release signer and dispute resolver are plain
// addresses here. The guard's own rules are tested in contracts/guard.
//
// Transactions are opaque tokens ("inmem:<n>"): each write returns one, and
// `sendTransaction` applies it, so a call built before a state change fails the
// way a stale envelope does on-chain.

import { createHash } from 'node:crypto';
import { StrKey } from '@stellar/stellar-sdk';
import { escrowToScVal, sameEscrowProperties, type EscrowSnapshot, type OnChainEscrow } from './escrow-types.js';
import { resolutionSplit, twStandardFees, TW_MAX_PLATFORM_FEE_BPS } from './fees.js';
import type {
  ApproveMilestoneRequest,
  DisputeEscrowRequest,
  EscrowApi,
  FundingHistory,
  FundEscrowRequest,
  FundRecord,
  InitializeEscrowRequest,
  ReleaseFundsRequest,
  ResolveDisputeRequest,
  SendResult,
  SignXdr,
  UnsignedTx,
  UpdateEscrowRequest,
} from './ports.js';

/** Error names follow the v1 contract's `ContractError` variants where one exists. */
export class TwContractError extends Error {
  constructor(public readonly code: string, message = code) {
    super(message);
    this.name = 'TwContractError';
  }
}

interface Stored {
  escrow: OnChainEscrow;
  balance: bigint;
  fundings: FundRecord[];
}

type Op = () => Partial<SendResult>;

/** Signing is a no-op for in-memory tokens. */
export const passthroughSignXdr: SignXdr = async (unsignedXdr) => unsignedXdr;

export class InMemoryEscrowApi implements EscrowApi, FundingHistory {
  private readonly escrows = new Map<string, Stored>();
  private readonly pending = new Map<string, Op>();
  private seq = 0;
  private deployed = 0;
  /** Token balances of every non-escrow address that received funds. */
  readonly balances = new Map<string, bigint>();
  /** Transfers out of escrows, in order. */
  readonly transfers: Array<{ from: string; to: string; amount: bigint }> = [];

  constructor(private readonly opts: { trustlessWorkFeeAddress: string }) {}

  async initialize(req: InitializeEscrowRequest): Promise<UnsignedTx> {
    return this.queue(() => {
      const e = req.escrow;
      if (e.amount <= 0n) throw new TwContractError('AmountCannotBeZero');
      if (BigInt(e.platformFeeBps) > TW_MAX_PLATFORM_FEE_BPS) throw new TwContractError('PlatformFeeTooHigh');
      if (e.milestones.length === 0) throw new TwContractError('NoMileStoneDefined');
      if (e.milestones.length > 50) throw new TwContractError('TooManyMilestones');
      const contractId = StrKey.encodeContract(createHash('sha256').update(`inmem-escrow-${++this.deployed}-${e.engagementId}`).digest());
      this.escrows.set(contractId, {
        escrow: { ...e, flags: { disputed: false, released: false, resolved: false }, milestones: e.milestones.map((m) => ({ ...m })) },
        balance: 0n,
        fundings: [],
      });
      return { contractId };
    });
  }

  async fund(req: FundEscrowRequest): Promise<UnsignedTx> {
    // Like Trustless Work, the call captures the current escrow as `expected_escrow`.
    const expected = structuredClone(this.get(req.contractId).escrow);
    return this.queue(() => {
      const s = this.get(req.contractId);
      if (req.amount <= 0n) throw new TwContractError('AmountCannotBeZero');
      if (!sameEscrowProperties(s.escrow, expected)) throw new TwContractError('EscrowPropertiesMismatch');
      s.balance += req.amount;
      s.fundings.push({ signer: req.signer, amount: req.amount });
      return {};
    });
  }

  async approve(req: ApproveMilestoneRequest): Promise<UnsignedTx> {
    return this.queue(() => {
      const s = this.get(req.contractId);
      if (req.approver !== s.escrow.roles.approver) throw new TwContractError('OnlyApproverChangeMilstoneFlag');
      const m = s.escrow.milestones[req.milestoneIndex];
      if (!m) throw new TwContractError('InvalidMileStoneIndex');
      if (m.status === '') throw new TwContractError('EmptyMilestoneStatus');
      if (m.approved) throw new TwContractError('MilestoneHasAlreadyBeenApproved');
      m.approved = true;
      return {};
    });
  }

  async changeDisputeFlag(req: DisputeEscrowRequest): Promise<UnsignedTx> {
    return this.queue(() => {
      const s = this.get(req.contractId);
      const r = s.escrow.roles;
      if (req.signer === r.disputeResolver) throw new TwContractError('DisputeResolverCannotDisputeTheEscrow');
      const isRole = [r.approver, r.serviceProvider, r.platform, r.releaseSigner, r.receiver].includes(req.signer);
      if (!isRole) throw new TwContractError('UnauthorizedToChangeDisputeFlag');
      if (s.escrow.flags.resolved) throw new TwContractError('EscrowAlreadyResolved');
      if (s.escrow.flags.disputed) throw new TwContractError('EscrowAlreadyInDispute');
      s.escrow.flags.disputed = true;
      return {};
    });
  }

  async release(req: ReleaseFundsRequest): Promise<UnsignedTx> {
    return this.queue(() => {
      const s = this.get(req.contractId);
      const e = s.escrow;
      if (req.releaseSigner !== e.roles.releaseSigner) throw new TwContractError('OnlyReleaseSignerCanReleaseEarnings');
      if (e.flags.released) throw new TwContractError('EscrowAlreadyReleased');
      if (e.flags.resolved) throw new TwContractError('EscrowAlreadyResolved');
      if (e.flags.disputed) throw new TwContractError('EscrowOpenedForDisputeResolution');
      if (!e.milestones.every((m) => m.approved)) throw new TwContractError('EscrowNotCompleted');
      if (s.balance < e.amount) throw new TwContractError('EscrowBalanceNotEnoughToSendEarnings');
      const f = twStandardFees(e.amount, BigInt(e.platformFeeBps));
      this.pay(req.contractId, this.opts.trustlessWorkFeeAddress, f.trustlessWorkFee);
      this.pay(req.contractId, e.roles.platform, f.platformFee);
      this.pay(req.contractId, e.roles.receiver, f.receiverAmount);
      s.balance -= e.amount;
      e.flags.released = true;
      return {};
    });
  }

  async resolve(req: ResolveDisputeRequest): Promise<UnsignedTx> {
    return this.queue(() => {
      const s = this.get(req.contractId);
      const e = s.escrow;
      if (req.disputeResolver !== e.roles.disputeResolver) throw new TwContractError('OnlyDisputeResolverCanExecuteThisFunction');
      if (!e.flags.disputed) throw new TwContractError('EscrowNotInDispute');
      if (s.balance <= 0n) throw new TwContractError('InsufficientFundsForResolution');
      const total = req.distributions.reduce((a, [, v]) => a + v, 0n);
      if (req.distributions.some(([, v]) => v <= 0n)) throw new TwContractError('AmountsToBeTransferredShouldBePositive');
      if (total !== s.balance) throw new TwContractError('DistributionsMustEqualEscrowBalance');
      const split = resolutionSplit(req.distributions, BigInt(e.platformFeeBps));
      this.pay(req.contractId, this.opts.trustlessWorkFeeAddress, split.trustlessWorkFee);
      this.pay(req.contractId, e.roles.platform, split.platformFee);
      for (const r of split.net) this.pay(req.contractId, r.address, r.amount);
      s.balance -= total;
      e.flags.disputed = false;
      e.flags.resolved = true;
      return {};
    });
  }

  async updateEscrow(req: UpdateEscrowRequest): Promise<UnsignedTx> {
    return this.queue(() => {
      const s = this.get(req.contractId);
      const cur = s.escrow;
      const next = req.escrow;
      if (req.signer !== cur.roles.platform) throw new TwContractError('OnlyPlatformAddressExecuteThisFunction');
      if (next.roles.platform !== cur.roles.platform) throw new TwContractError('PlatformAddressCannotBeChanged');
      if (cur.flags.disputed) throw new TwContractError('EscrowOpenedForDisputeResolution');
      if (cur.milestones.some((m) => m.approved)) throw new TwContractError('MilestoneApprovedCantChangeEscrowProperties');
      if (next.flags.disputed || next.flags.released || next.flags.resolved) throw new TwContractError('FlagsMustBeFalse');
      if (s.balance > 0n) {
        // Funded: only appending unapproved milestones is allowed.
        const head = { ...next, milestones: next.milestones.slice(0, cur.milestones.length) };
        const appended = next.milestones.slice(cur.milestones.length);
        if (!sameEscrowProperties(head, cur) || appended.some((m) => m.approved)) throw new TwContractError('EscrowPropertiesMismatch');
      }
      s.escrow = { ...next, flags: { ...cur.flags }, milestones: next.milestones.map((m) => ({ ...m })) };
      return {};
    });
  }

  async getEscrow(contractId: string): Promise<EscrowSnapshot> {
    const s = this.get(contractId);
    return { ...structuredClone(s.escrow), contractId, balance: s.balance };
  }

  async sendTransaction(signedXdr: string): Promise<SendResult> {
    const op = this.pending.get(signedXdr);
    if (!op) throw new TwContractError('UnknownTransaction', `no pending in-memory transaction ${signedXdr}`);
    this.pending.delete(signedXdr);
    const r = op();
    return { status: 'SUCCESS', txHash: createHash('sha256').update(signedXdr).digest('hex'), ...r };
  }

  async fundings(contractId: string): Promise<FundRecord[]> {
    return this.get(contractId).fundings.map((f) => ({ ...f }));
  }

  /** Test helper: a plain token transfer into an escrow (no `fund_escrow`, no event). */
  transferIn(contractId: string, amount: bigint): void {
    this.get(contractId).balance += amount;
  }

  /** Test helper: the escrow's value as the contract would encode it. */
  encoded(contractId: string): string {
    return escrowToScVal(this.get(contractId).escrow).toXDR('base64');
  }

  private pay(from: string, to: string, amount: bigint): void {
    if (amount <= 0n) return;
    this.balances.set(to, (this.balances.get(to) ?? 0n) + amount);
    this.transfers.push({ from, to, amount });
  }

  private get(contractId: string): Stored {
    const s = this.escrows.get(contractId);
    if (!s) throw new TwContractError('EscrowNotFound');
    return s;
  }

  private queue(op: Op): UnsignedTx {
    const token = `inmem:${++this.seq}`;
    this.pending.set(token, op);
    return { unsignedXdr: token };
  }
}
