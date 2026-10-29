// SPDX-License-Identifier: Apache-2.0
//
// Escrow lifecycle for one order, over the EscrowApi port (SCF deliverables D1,
// D3b). It encodes the order-side rules of docs/architecture.md, section 7:
//
//  - every escrow field is final before the buyer sees the address: a missing
//    milestone status is set with `update_escrow` right after creation;
//  - an order is paid only when the buyer's own `fund_escrow` calls add up to the
//    escrow amount; partial funding never marks it paid, a third party's funding
//    never counts, and any balance above the amount is flagged;
//  - cancellation before funding changes a field Trustless Work freezes once the
//    escrow holds funds (the title, to a cancellation marker), so it succeeds only
//    at balance 0 and also invalidates the buyer's prepared funding call;
//  - a refund resolves the whole balance to the buyer and returns the fee top-up
//    the platform owes the buyer so the buyer receives 100%.
//
// Guard-held releases and resolutions on a real network go through
// ReleaseService; the `release`/`resolve` paths here drive the same EscrowApi
// operations for the in-memory model and the example.

import { randomBytes } from 'node:crypto';
import { EscrowStateError } from './errors.js';
import type { EscrowSnapshot, OnChainEscrow } from './escrow-types.js';
import { quoteEscrow, refundTopUp, sellerResolution, type EscrowQuote, type RefundTopUp } from './fees.js';
import type { EscrowApi, EscrowOrder, FundingHistory, FundRecord, Signer, SignXdr, UnsignedTx } from './ports.js';

export interface LifecycleConfig {
  /** Platform fee account (the escrow's `platform` role). */
  platform: Signer;
  /** Address holding `release_signer` and `dispute_resolver` (the guard contract). */
  guardAddress: string;
  /** Token contract the escrow holds (EURC SAC). */
  tokenContractId: string;
  tokenSymbol?: string;
  /** Milestone status set at creation. Must be non-empty. */
  milestoneStatus?: string;
  milestoneDescription?: string;
  /** Title prefix written by a cancellation. */
  cancelMarker?: string;
}

export interface FundingAssessment {
  balance: bigint;
  /** Sum of `fund_escrow` calls signed by the order's buyer. */
  buyerFunded: bigint;
  /** Sum of `fund_escrow` calls by anyone else. */
  thirdPartyFunded: bigint;
  /** Balance not explained by `fund_escrow` calls (plain transfers into the escrow). */
  unexplained: bigint;
  paid: boolean;
  /** Balance above the escrow amount. */
  excess: bigint;
  flags: Array<'PARTIAL' | 'EXCESS_BALANCE' | 'THIRD_PARTY_FUNDING' | 'UNEXPLAINED_BALANCE'>;
}

/**
 * Pure funding rule. Paid means the buyer's own `fund_escrow` calls reach the
 * amount (and the balance is there); nothing else ever marks an order paid.
 */
export function assessFunding(escrow: { amount: bigint; balance: bigint }, buyer: string, fundings: readonly FundRecord[]): FundingAssessment {
  let buyerFunded = 0n;
  let thirdPartyFunded = 0n;
  for (const f of fundings) {
    if (f.signer === buyer) buyerFunded += f.amount;
    else thirdPartyFunded += f.amount;
  }
  const flags: FundingAssessment['flags'] = [];
  const paid = buyerFunded >= escrow.amount && escrow.balance >= escrow.amount;
  const excess = escrow.balance > escrow.amount ? escrow.balance - escrow.amount : 0n;
  const unexplained = escrow.balance - buyerFunded - thirdPartyFunded;
  if (!paid && escrow.balance > 0n) flags.push('PARTIAL');
  if (excess > 0n) flags.push('EXCESS_BALANCE');
  if (thirdPartyFunded > 0n) flags.push('THIRD_PARTY_FUNDING');
  if (unexplained > 0n) flags.push('UNEXPLAINED_BALANCE');
  return { balance: escrow.balance, buyerFunded, thirdPartyFunded, unexplained, paid, excess, flags };
}

export type CancelOutcome =
  | { cancelled: true }
  | {
      cancelled: false;
      /** The buyer's funds landed: refund through a dispute and resolution. */
      next: 'refund-buyer' | 'dispute-and-resolve-dust-to-buyer';
      funding: FundingAssessment;
    };

export class EscrowLifecycle {
  constructor(
    private readonly api: EscrowApi,
    private readonly signXdr: SignXdr,
    private readonly history: FundingHistory,
    private readonly cfg: LifecycleConfig,
  ) {}

  /**
   * Quotes the order, deploys its escrow and makes every field final. Returns the
   * escrow's contract ID and the fee quote. Throws `FeeRuleError` when the order is
   * not eligible for the escrow rail.
   */
  async create(order: EscrowOrder): Promise<{ contractId: string; quote: EscrowQuote }> {
    const quote = quoteEscrow({ amount: order.amount, cardNet: order.cardNet });
    const status = this.cfg.milestoneStatus ?? 'awaiting delivery';
    if (!status) throw new EscrowStateError('EMPTY_STATUS', 'milestone status must be non-empty');
    const escrow: Omit<OnChainEscrow, 'flags'> = {
      // Escrow text fields are public: random or generic values only.
      engagementId: randomBytes(8).toString('hex'),
      title: 'order',
      description: 'part',
      roles: {
        approver: order.buyer,
        serviceProvider: order.seller,
        receiver: order.seller,
        platform: this.cfg.platform.publicKey(),
        releaseSigner: this.cfg.guardAddress,
        disputeResolver: this.cfg.guardAddress,
      },
      amount: order.amount,
      platformFeeBps: Number(quote.platformFeeBps),
      milestones: [{ description: this.cfg.milestoneDescription ?? 'part delivered', status, evidence: '', approved: false }],
      trustline: this.cfg.tokenContractId,
      receiverMemo: 0,
    };
    const sent = await this.submit(
      await this.api.initialize({ signer: this.cfg.platform.publicKey(), escrow, trustlineSymbol: this.cfg.tokenSymbol ?? 'EURC' }),
      this.cfg.platform,
    );
    if (!sent.contractId) throw new EscrowStateError('NO_CONTRACT_ID', 'deployment did not return a contract ID');

    // Every field final before the address is shown: set a status the API left empty.
    const snap = await this.api.getEscrow(sent.contractId);
    if (snap.milestones.some((m) => m.status === '')) {
      await this.submit(
        await this.api.updateEscrow({
          contractId: sent.contractId,
          signer: this.cfg.platform.publicKey(),
          escrow: { ...stripSnapshot(snap), milestones: snap.milestones.map((m) => ({ ...m, status: m.status || status })) },
        }),
        this.cfg.platform,
      );
    }
    return { contractId: sent.contractId, quote };
  }

  /** Builds the buyer's funding call for exactly the escrow amount. */
  async fundingCall(contractId: string, buyer: string): Promise<UnsignedTx> {
    const snap = await this.api.getEscrow(contractId);
    if (snap.roles.approver !== buyer) throw new EscrowStateError('NOT_BUYER', 'funding wallet is not the escrow approver');
    if (snap.balance !== 0n) throw new EscrowStateError('NOT_EMPTY', 'escrow already holds a balance; it is never shown to a buyer');
    if (snap.flags.disputed || snap.flags.released || snap.flags.resolved) throw new EscrowStateError('SETTLED', 'escrow is not open');
    return this.api.fund({ contractId, signer: buyer, amount: snap.amount });
  }

  /** Signs and submits a funding call with the buyer's signer (examples and tests). */
  async fund(contractId: string, buyer: Signer, amount?: bigint): Promise<void> {
    const call = amount === undefined
      ? await this.fundingCall(contractId, buyer.publicKey())
      : await this.api.fund({ contractId, signer: buyer.publicKey(), amount });
    await this.submit(call, buyer);
  }

  /** Current funding assessment from the escrow balance and its `fund_escrow` history. */
  async funding(contractId: string): Promise<FundingAssessment> {
    const snap = await this.api.getEscrow(contractId);
    return assessFunding(snap, snap.roles.approver, await this.history.fundings(contractId));
  }

  async approve(contractId: string, buyer: Signer): Promise<void> {
    await this.submit(await this.api.approve({ contractId, milestoneIndex: 0, approver: buyer.publicKey() }), buyer);
  }

  async openDispute(contractId: string, by: Signer): Promise<void> {
    await this.submit(await this.api.changeDisputeFlag({ contractId, signer: by.publicKey() }), by);
  }

  /**
   * Cancels an unfunded escrow by rewriting its title to a cancellation marker.
   * If the escrow already holds a balance, nothing is changed and the outcome
   * says which unwind applies.
   */
  async cancel(contractId: string): Promise<CancelOutcome> {
    const snap = await this.api.getEscrow(contractId);
    if (snap.balance === 0n && !snap.flags.disputed) {
      const marker = `${this.cfg.cancelMarker ?? 'cancelled'}:${randomBytes(4).toString('hex')}`;
      try {
        await this.submit(
          await this.api.updateEscrow({ contractId, signer: this.cfg.platform.publicKey(), escrow: { ...stripSnapshot(snap), title: marker } }),
          this.cfg.platform,
        );
        return { cancelled: true };
      } catch {
        // Funds landed between the read and the update: fall through to the unwind.
      }
    }
    const funding = await this.funding(contractId);
    return { cancelled: false, next: funding.buyerFunded > 0n ? 'refund-buyer' : 'dispute-and-resolve-dust-to-buyer', funding };
  }

  /**
   * Refund before release: opens a platform dispute if none is open, resolves the
   * whole live balance to the buyer, and returns the top-up the platform must send
   * the buyer (Trustless Work fee + platform fee withheld by the resolution).
   */
  async refund(contractId: string, resolver: Signer): Promise<RefundTopUp & { buyer: string }> {
    let snap = await this.api.getEscrow(contractId);
    if (snap.flags.released || snap.flags.resolved) throw new EscrowStateError('SETTLED', 'escrow already released or resolved');
    if (snap.balance <= 0n) throw new EscrowStateError('EMPTY', 'nothing to refund');
    if (!snap.flags.disputed) {
      await this.openDispute(contractId, this.cfg.platform);
      snap = await this.api.getEscrow(contractId);
    }
    const buyer = snap.roles.approver;
    await this.submit(
      await this.api.resolve({ contractId, disputeResolver: snap.roles.disputeResolver, distributions: [[buyer, snap.balance]] }),
      resolver,
    );
    return { ...refundTopUp(snap.balance, BigInt(snap.platformFeeBps), buyer), buyer };
  }

  /** Seller-favoured resolution: seller gets at most the amount, any excess goes to the buyer. */
  async resolveToSeller(contractId: string, resolver: Signer): Promise<void> {
    const snap = await this.api.getEscrow(contractId);
    if (!snap.flags.disputed) throw new EscrowStateError('NOT_DISPUTED', 'a resolution needs an open dispute');
    const dist = sellerResolution(snap.balance, snap.amount, snap.roles.receiver, snap.roles.approver);
    await this.submit(await this.api.resolve({ contractId, disputeResolver: snap.roles.disputeResolver, distributions: dist }), resolver);
  }

  /** Release through the EscrowApi (in-memory model; on a network use ReleaseService). */
  async release(contractId: string, releaseSigner: Signer): Promise<void> {
    await this.submit(await this.api.release({ contractId, releaseSigner: this.cfg.guardAddress }), releaseSigner);
  }

  private async submit(tx: UnsignedTx, signer: Signer) {
    const signed = await this.signXdr(tx.unsignedXdr, signer);
    const r = await this.api.sendTransaction(signed);
    if (r.status !== 'SUCCESS') throw new EscrowStateError('SUBMIT_FAILED', r.message ?? 'transaction failed');
    return r;
  }
}

function stripSnapshot(s: EscrowSnapshot): OnChainEscrow {
  const { contractId: _c, balance: _b, ...rest } = s;
  return { ...rest, milestones: rest.milestones.map((m) => ({ ...m })), flags: { ...rest.flags }, roles: { ...rest.roles } };
}
