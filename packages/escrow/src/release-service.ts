// SPDX-License-Identifier: Apache-2.0
//
// Release service (SCF deliverable D6, submission path). Builds `release_funds`,
// `resolve_dispute` and `withdraw_remaining_funds` directly against the escrow
// contract through Soroban RPC, with the guard's custom-account authorization
// entry. Trustless Work's REST release endpoints return an unsigned XDR for a
// G-account signer and do not build the Soroban auth entry that the guard's
// __check_auth checks, so this path builds and simulates those calls whenever the
// guard holds the roles.
//
// Flow per call (ported from arch8.mjs `guarded`, guardcall.js "resim" mode):
//   1. build the invocation with the submitter as source and simulate it in
//      record mode; the host returns an unsigned entry for the guard address;
//   2. sign that entry with the branch's guard key (release, resolver, break-glass);
//   3. rebuild with the signed entry and simulate in enforce mode, so the guard's
//      `__check_auth` runs and the footprint includes everything it reads
//      (attaching the signed entry to the first simulation's footprint is the
//      "naive" variant the lab showed to be fragile);
//   4. assemble, sign the envelope as the submitter, submit.

import { scValToNative } from '@stellar/stellar-sdk';
import { GuardedCallError, contractErrorCode } from './errors.js';
import { signGuardEntries, type DeliveryClaim, type GuardBranch } from './guard-auth.js';
import type { TwLineage } from './network.js';
import type { Signer, Submitter, SubmitResult } from './ports.js';
import { addr, addressAmountMap } from './scval.js';
import { buildInvocation, signTransaction, simulateRead, type ContractCall } from './soroban.js';
import type { Transaction } from '@stellar/stellar-sdk';

export interface ReleaseServiceConfig {
  networkPassphrase: string;
  guardContractId: string;
  /** EURC SAC, used to read an escrow's live balance before a resolution. */
  tokenContractId: string;
  lineage: TwLineage;
  /** Pays fees and submits; the envelope source. Holds no escrow role. */
  submitter: Signer;
  releaseKey: Signer;
  resolverKey: Signer;
  /** Offline in production; only needed for break-glass refunds. */
  breakGlassKey?: Signer;
  /** Ledgers an auth signature stays valid. Default 200 (about 17 minutes). */
  authValidityLedgers?: number;
  /**
   * Called before any payout that includes the seller (seller verification,
   * tax-reporting gates, recipient trustline checks). Throw to refuse.
   */
  sellerPayoutGate?: (ctx: { escrowContractId: string; seller: string; amount: bigint }) => Promise<void>;
}

export interface GuardedCallOptions {
  branch: GuardBranch;
  claim?: DeliveryClaim;
  /** Build and enforce-simulate only; return the ready transaction without submitting. */
  dryRun?: boolean;
}

export interface GuardedCallResult {
  /** Ready (signed) transaction. */
  tx: Transaction;
  /** Present unless `dryRun`. */
  submit?: SubmitResult;
  minResourceFee: bigint;
}

export class ReleaseService {
  constructor(private readonly rpc: Submitter, private readonly cfg: ReleaseServiceConfig) {}

  /** `release_funds` arguments for the configured lineage. */
  releaseArgs() {
    return this.cfg.lineage.kind === 'fee-address-argument'
      ? [addr(this.cfg.guardContractId), addr(this.cfg.lineage.trustlessWorkFeeAddress)]
      : [addr(this.cfg.guardContractId)];
  }

  /** `resolve_dispute` / `withdraw_remaining_funds` arguments for the configured lineage. */
  distributionArgs(distributions: ReadonlyArray<readonly [string, bigint]>) {
    const map = addressAmountMap(distributions);
    return this.cfg.lineage.kind === 'fee-address-argument'
      ? [addr(this.cfg.guardContractId), addr(this.cfg.lineage.trustlessWorkFeeAddress), map]
      : [addr(this.cfg.guardContractId), map];
  }

  /**
   * Release to the escrow's fixed receiver. Trustless Work itself requires every
   * milestone approved by the buyer and no open dispute; the guard requires the
   * release key and an open registration.
   */
  async release(escrowContractId: string, opts: { seller?: string; amount?: bigint; dryRun?: boolean } = {}): Promise<GuardedCallResult> {
    if (opts.seller && this.cfg.sellerPayoutGate) {
      await this.cfg.sellerPayoutGate({ escrowContractId, seller: opts.seller, amount: opts.amount ?? 0n });
    }
    return this.guardedCall({ contractId: escrowContractId, fn: 'release_funds', args: this.releaseArgs() }, { branch: 'Release', dryRun: opts.dryRun });
  }

  /**
   * Resolve an open dispute. The distribution must sum to the live balance; use
   * `resolveFromLiveBalance` to build it from a fresh read. Payouts that include
   * the seller need either a delivery claim (`ResolveSeller`) or the guard's
   * approval path (`Resolve` after the contest window); buyer-only payouts use
   * `Resolve` or, with the offline key, `BreakGlass`.
   */
  async resolve(
    escrowContractId: string,
    distributions: ReadonlyArray<readonly [string, bigint]>,
    opts: { branch?: GuardBranch; claim?: DeliveryClaim; seller?: string; dryRun?: boolean } = {},
  ): Promise<GuardedCallResult> {
    const branch: GuardBranch = opts.branch ?? (opts.claim ? 'ResolveSeller' : 'Resolve');
    if (opts.seller && this.cfg.sellerPayoutGate) {
      const toSeller = distributions.find(([a]) => a === opts.seller);
      if (toSeller) await this.cfg.sellerPayoutGate({ escrowContractId, seller: opts.seller, amount: toSeller[1] });
    }
    return this.guardedCall(
      { contractId: escrowContractId, fn: 'resolve_dispute', args: this.distributionArgs(distributions) },
      { branch, claim: opts.claim, dryRun: opts.dryRun },
    );
  }

  /** Withdraw what is left after a release or resolution; the guard pays only the stored buyer. */
  async withdrawRemaining(
    escrowContractId: string,
    distributions: ReadonlyArray<readonly [string, bigint]>,
    opts: { dryRun?: boolean } = {},
  ): Promise<GuardedCallResult> {
    return this.guardedCall(
      { contractId: escrowContractId, fn: 'withdraw_remaining_funds', args: this.distributionArgs(distributions) },
      { branch: 'Resolve', dryRun: opts.dryRun },
    );
  }

  /** Reads an escrow's EURC balance through the SAC, by simulation. */
  async escrowBalance(escrowContractId: string): Promise<bigint> {
    const r = await simulateRead(
      this.rpc,
      this.cfg.submitter.publicKey(),
      { contractId: this.cfg.tokenContractId, fn: 'balance', args: [addr(escrowContractId)] },
      this.cfg.networkPassphrase,
    );
    if (!r.ok || !r.retval) throw new Error(`balance read failed: ${r.ok ? 'no value' : r.error}`);
    return BigInt(scValToNative(r.retval) as bigint);
  }

  /**
   * Builds the distribution from the balance read just before submission and
   * rebuilds once if the balance moved in between (Trustless Work requires the map
   * to sum exactly to the live balance).
   */
  async resolveFromLiveBalance(
    escrowContractId: string,
    distribute: (balance: bigint) => Array<[string, bigint]>,
    opts: { branch?: GuardBranch; claim?: DeliveryClaim; seller?: string } = {},
  ): Promise<GuardedCallResult> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      const balance = await this.escrowBalance(escrowContractId);
      try {
        return await this.resolve(escrowContractId, distribute(balance), opts);
      } catch (e) {
        lastError = e;
        const after = await this.escrowBalance(escrowContractId);
        if (after === balance) throw e;
      }
    }
    throw lastError;
  }

  /** Record-simulate, sign the guard entry, enforce-simulate, then submit. */
  async guardedCall(call: ContractCall, opts: GuardedCallOptions): Promise<GuardedCallResult> {
    const key = this.keyFor(opts.branch);
    const source = this.cfg.submitter.publicKey();

    const tx0 = await buildInvocation(this.rpc, source, call, { networkPassphrase: this.cfg.networkPassphrase });
    const recorded = await this.rpc.simulate(tx0, 'record');
    if (!recorded.ok) {
      throw new GuardedCallError(`${call.fn}: ${recorded.error.split('\n')[0]}`, 'record-simulation', recorded.contractErrorCode ?? contractErrorCode(recorded.error));
    }

    const latest = await this.rpc.getLatestLedger();
    const auth = await signGuardEntries(recorded.auth, {
      guardContractId: this.cfg.guardContractId,
      networkPassphrase: this.cfg.networkPassphrase,
      validUntilLedger: latest + (this.cfg.authValidityLedgers ?? 200),
      key,
      branch: opts.branch,
      claim: opts.claim,
      expect: { contractId: call.contractId, fn: call.fn },
    });

    const tx1 = await buildInvocation(this.rpc, source, call, { networkPassphrase: this.cfg.networkPassphrase, auth });
    const enforced = await this.rpc.simulate(tx1, 'enforce');
    if (!enforced.ok) {
      throw new GuardedCallError(`${call.fn}: ${enforced.error.split('\n')[0]}`, 'enforce-simulation', enforced.contractErrorCode ?? contractErrorCode(enforced.error));
    }
    const ready = enforced.prepare(tx1);
    await signTransaction(ready, this.cfg.submitter);
    if (opts.dryRun) return { tx: ready, minResourceFee: enforced.minResourceFee };

    const submit = await this.rpc.send(ready);
    if (submit.status !== 'SUCCESS') {
      throw new GuardedCallError(`${call.fn}: transaction ${submit.hash} ${submit.status}`, 'submit');
    }
    return { tx: ready, submit, minResourceFee: enforced.minResourceFee };
  }

  private keyFor(branch: GuardBranch): Signer {
    switch (branch) {
      case 'Release':
        return this.cfg.releaseKey;
      case 'Resolve':
      case 'ResolveSeller':
        return this.cfg.resolverKey;
      case 'BreakGlass':
        if (!this.cfg.breakGlassKey) throw new Error('break-glass key not configured');
        return this.cfg.breakGlassKey;
    }
  }
}
