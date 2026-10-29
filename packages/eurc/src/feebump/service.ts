/**
 * Fee-bump service: policy check, rate limit, re-simulation, wrap, sign,
 * submit. This is the only place the sponsor key signs a fee-bump.
 *
 * Order of checks (each is cheaper than the next, and nothing is signed until
 * all pass):
 *   1. `FeeBumpPolicy.evaluate` (allowlist, source signature, fee caps)
 *   2. per-wallet rate limit
 *   3. for Soroban: re-simulate the inner tx as signed; refuse when the
 *      simulation fails or the network now needs a larger resource fee than
 *      the inner tx declares (the wallet must re-simulate, rebuild and re-sign)
 *   4. build the fee-bump, check its total fee against the cap, sign, submit
 */
import { BASE_FEE, TransactionBuilder, type FeeBumpTransaction, type Transaction } from "@stellar/stellar-sdk";
import { assertTestnet } from "../network.js";
import type { RateLimiter, Signer, SubmitOutcome, Submitter } from "../ports.js";
import { attachSignature, hasValidSignatureFrom } from "../signers.js";
import { declaredResourceFee } from "./inspect.js";
import type { AllowedAction, FeeBumpPolicy, RejectReason } from "./policy.js";

export interface FeeBumpServiceDeps {
  readonly policy: FeeBumpPolicy;
  /** The sponsor key; its public key must equal the policy's sponsorPublicKey. */
  readonly sponsor: Signer;
  readonly submitter: Submitter;
  readonly rateLimiter: RateLimiter;
  /** Minimum per-operation inclusion fee the sponsor bids, in stroops. Default BASE_FEE. */
  readonly baseFee?: string;
}

export type ServiceRejectReason = RejectReason | "rate-limited" | "simulation-failed" | "resource-fee-stale" | "fee-bump-above-cap";

export type FeeBumpResult =
  | {
      readonly ok: true;
      readonly action: AllowedAction;
      readonly feeBump: FeeBumpTransaction;
      readonly outcome: SubmitOutcome;
    }
  | { readonly ok: false; readonly reason: ServiceRejectReason; readonly detail?: string };

export class FeeBumpService {
  private readonly baseFee: bigint;

  constructor(private readonly deps: FeeBumpServiceDeps) {
    if (deps.sponsor.publicKey() !== deps.policy.config.sponsorPublicKey) {
      throw new Error("sponsor signer does not match the policy's sponsorPublicKey");
    }
    if (deps.submitter.networkPassphrase !== deps.policy.config.networkPassphrase) {
      throw new Error("submitter and policy are on different networks");
    }
    assertTestnet(deps.submitter.networkPassphrase);
    this.baseFee = BigInt(deps.baseFee ?? BASE_FEE);
  }

  /** Check `inner` against the allowlist and, if allowed, wrap it, sign it and submit it. */
  async bumpAndSubmit(inner: Transaction): Promise<FeeBumpResult> {
    const prepared = await this.prepare(inner);
    if (!prepared.ok) return prepared;
    const outcome = await this.deps.submitter.submit(prepared.feeBump);
    return { ...prepared, outcome };
  }

  /**
   * Everything `bumpAndSubmit` does except the submission. Returns the signed
   * fee-bump, so a host can submit it through its own pipeline.
   */
  async prepare(
    inner: Transaction,
  ): Promise<
    | { readonly ok: true; readonly action: AllowedAction; readonly feeBump: FeeBumpTransaction }
    | { readonly ok: false; readonly reason: ServiceRejectReason; readonly detail?: string }
  > {
    const { policy, sponsor, submitter, rateLimiter } = this.deps;
    const decision = await policy.evaluate(inner);
    if (!decision.allowed) return { ok: false, reason: decision.reason, detail: decision.detail };

    if (!(await rateLimiter.take(inner.source))) return { ok: false, reason: "rate-limited" };

    if (decision.soroban) {
      const sim = await submitter.simulate(inner);
      if (!sim.ok) return { ok: false, reason: "simulation-failed", detail: sim.error };
      if (sim.minResourceFee !== undefined && BigInt(sim.minResourceFee) > declaredResourceFee(inner)) {
        return { ok: false, reason: "resource-fee-stale", detail: `needs ${sim.minResourceFee}` };
      }
    }

    // The sponsored-trustline sandwich names the sponsor as the Begin source,
    // so the sponsor co-signs the inner tx before wrapping it.
    if (decision.action.kind === "sponsored_trustline" && !hasValidSignatureFrom(inner, sponsor.publicKey())) {
      await attachSignature(inner, sponsor);
    }

    const feeBump = TransactionBuilder.buildFeeBumpTransaction(
      sponsor.publicKey(),
      this.bidPerOp(inner).toString(),
      inner,
      inner.networkPassphrase,
    );
    if (BigInt(feeBump.fee) > policy.caps.feeBumpTotalFee) {
      return { ok: false, reason: "fee-bump-above-cap", detail: `fee-bump fee ${feeBump.fee}` };
    }
    await attachSignature(feeBump, sponsor);
    return { ok: true, action: decision.action, feeBump };
  }

  /**
   * Per-operation inclusion bid for the outer tx: the larger of the inner
   * tx's own inclusion bid and the configured base fee (a fee-bump may not
   * bid less per operation than its inner tx).
   */
  private bidPerOp(inner: Transaction): bigint {
    const ops = BigInt(Math.max(inner.operations.length, 1));
    const innerInclusion = (BigInt(inner.fee) - declaredResourceFee(inner)) / ops;
    return innerInclusion > this.baseFee ? innerInclusion : this.baseFee;
  }
}
