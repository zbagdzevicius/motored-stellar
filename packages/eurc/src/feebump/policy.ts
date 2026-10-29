/**
 * Fee-bump allowlist.
 *
 * The sponsor pays network fees so that users can hold and move EURC with
 * 0 XLM (lab E2: a 0-XLM account's SAC transfer to a contract, fee-bumped by
 * the sponsor, `9e0d5cb5...`; the same call without a fee-bump fails
 * txInsufficientBalance). A sponsor that bumps anything is a faucet, so this
 * policy accepts an inner transaction only when ALL of these hold:
 *
 *  1. It is on the configured network and is not itself a fee-bump.
 *  2. Its source is a wallet the host registered, and that wallet signed it.
 *  3. It has bounded validity (maxTime set and within `maxValiditySeconds`).
 *  4. Its fee is within the cap for its kind (classic per-op / Soroban total).
 *  5. Its operations are exactly one of these shapes:
 *     - `fund_escrow(signer = source, expected_escrow, amount > 0)` on one of
 *       the source's escrows;
 *     - `approve_milestone(index, approver = source)` on one of its escrows;
 *     - `dispute_escrow(signer = source)` on one of its escrows;
 *     - `contest(escrow, evidence: BytesN<32>)` on the configured guard, where
 *       `escrow` is one of the source's escrows;
 *     - a sponsored EURC trustline sandwich (Begin by the sponsor for the
 *       source, ChangeTrust(EURC) with the default limit, End by the source);
 *     - a classic EURC payment from the source to the source's stored ramp
 *       destination (address and memo must match);
 *     - a classic EURC payment from the source to the configured platform
 *       address: the order's shipping, paid outside the escrow in the funding
 *       step (a Soroban transaction holds one operation, so it cannot ride
 *       inside the `fund_escrow` transaction).
 *     Soroban calls may carry only source-account authorisation entries;
 *     address entries are refused whether they arrive as the legacy variant
 *     or as `sorobanCredentialsAddressV2` (CAP-71).
 *
 * Everything else (payments to arbitrary addresses, SetOptions, extra
 * operations, other contracts or functions, an unregistered source, a fee
 * above the cap) is rejected with a machine-readable reason.
 *
 * Function names and argument orders are those of Trustless Work's escrow
 * contract (`contracts/escrow/src/contract.rs`: `fund_escrow(signer,
 * expected_escrow, amount)`, `approve_milestone(milestone_index, approver)`,
 * `dispute_escrow(signer)`) and of this repo's guard
 * (`contest(escrow, evidence)`).
 */
import {
  Asset,
  FeeBumpTransaction,
  StrKey,
  type Operation,
  type OperationRecord,
  type Transaction,
} from "@stellar/stellar-sdk";
import type { Clock, WalletRegistry } from "../ports.js";
import { systemClock } from "../memory.js";
import { hasValidSignatureFrom } from "../signers.js";
import {
  asContractCall,
  declaredResourceFee,
  isSorobanTx,
  onlySourceAccountAuth,
  scAddress,
  scBytesN,
  scI128,
  scU32,
  type ContractCall,
} from "./inspect.js";

/** Default ChangeTrust limit (int64 max in 7-decimal units). */
export const MAX_TRUST_LIMIT = "922337203685.4775807";

export interface FeeCaps {
  /** Max inclusion fee per operation for classic inner txs, in stroops. */
  readonly classicFeePerOp: bigint;
  /** Max total fee (inclusion + resource) for Soroban inner txs, in stroops. */
  readonly sorobanTotalFee: bigint;
  /** Max fee of the outer fee-bump the sponsor signs, in stroops. */
  readonly feeBumpTotalFee: bigint;
}

/**
 * Default caps. The lab's fee-bumped SAC transfer declared 4,429,197 stroops
 * and was charged 3,848,293 (testnet, `9e0d5cb5...`).
 *
 * Calibrated 29 Oct 2026 from the testnet runs on @stellar/stellar-sdk 17.4
 * (Horizon `max_fee` / `fee_charged`, docs/testnet-proofs.md): Trustless Work
 * `fund_escrow` in run 4 declared 1,126,545 and was charged 107,507 stroops;
 * guard `contest` in runs 5 and 6 declared 1,009,996 and was charged 5,108.
 * The 1 XLM `sorobanTotalFee` cap is about 9x the highest declared fee. Lab
 * run 1's first funding (24 Oct 2026) was charged 10,830,314 stroops, above
 * this cap; mainnet fees are not measured yet, so re-check before mainnet.
 */
export const DEFAULT_FEE_CAPS: FeeCaps = Object.freeze({
  classicFeePerOp: 10_000n, // 0.001 XLM
  sorobanTotalFee: 10_000_000n, // 1 XLM
  feeBumpTotalFee: 12_000_000n, // 1.2 XLM
});

export interface FeeBumpPolicyConfig {
  readonly networkPassphrase: string;
  /** The EURC asset (or the XEUR stand-in on testnet demos). */
  readonly eurc: Asset;
  /** C... id of the escrow guard contract that exposes `contest`. */
  readonly guardContractId: string;
  /** G... key of the sponsor (fee source and trustline sponsor). */
  readonly sponsorPublicKey: string;
  /**
   * G... platform (fee) address the guard pins as every escrow's `platform`.
   * When set, a buyer's EURC payment to it (shipping, outside the escrow) is
   * sponsored. Unset, such a payment is refused like any other destination.
   */
  readonly platformAddress?: string;
  readonly registry: WalletRegistry;
  readonly caps?: FeeCaps;
  /** Longest validity window the sponsor will pay for. Default 600 s. */
  readonly maxValiditySeconds?: number;
  readonly clock?: Clock;
}

/** What an accepted inner transaction does. */
export type AllowedAction =
  | { readonly kind: "fund_escrow"; readonly escrow: string; readonly amount: bigint }
  | { readonly kind: "approve_milestone"; readonly escrow: string; readonly milestoneIndex: number }
  | { readonly kind: "dispute_escrow"; readonly escrow: string }
  | { readonly kind: "contest"; readonly escrow: string }
  | { readonly kind: "sponsored_trustline" }
  | { readonly kind: "offramp_payment"; readonly destination: string; readonly amount: string }
  | { readonly kind: "shipping_payment"; readonly destination: string; readonly amount: string };

export type RejectReason =
  | "wrong-network"
  | "nested-fee-bump"
  | "unregistered-source"
  | "missing-source-signature"
  | "unbounded-validity"
  | "fee-above-cap"
  | "operation-count"
  | "operation-not-allowed"
  | "contract-not-allowed"
  | "function-not-allowed"
  | "bad-arguments"
  | "not-own-escrow"
  | "foreign-auth"
  | "foreign-op-source"
  | "wrong-asset"
  | "destination-not-allowed"
  | "memo-mismatch";

export type PolicyDecision =
  | { readonly allowed: true; readonly action: AllowedAction; readonly soroban: boolean }
  | { readonly allowed: false; readonly reason: RejectReason; readonly detail?: string };

const reject = (reason: RejectReason, detail?: string): PolicyDecision => ({ allowed: false, reason, detail });

export class FeeBumpPolicy {
  readonly caps: FeeCaps;
  private readonly maxValidity: number;
  private readonly clock: Clock;

  constructor(readonly config: FeeBumpPolicyConfig) {
    if (!StrKey.isValidContract(config.guardContractId)) throw new Error("guardContractId must be a C... address");
    if (!StrKey.isValidEd25519PublicKey(config.sponsorPublicKey)) throw new Error("sponsorPublicKey must be a G... key");
    if (config.platformAddress !== undefined && !StrKey.isValidEd25519PublicKey(config.platformAddress)) {
      throw new Error("platformAddress must be a G... key");
    }
    this.caps = config.caps ?? DEFAULT_FEE_CAPS;
    this.maxValidity = config.maxValiditySeconds ?? 600;
    this.clock = config.clock ?? systemClock;
  }

  /** Decide whether the sponsor may fee-bump `inner`. Never throws on bad input. */
  async evaluate(inner: Transaction | FeeBumpTransaction): Promise<PolicyDecision> {
    if (inner instanceof FeeBumpTransaction) return reject("nested-fee-bump");
    if (inner.networkPassphrase !== this.config.networkPassphrase) return reject("wrong-network");

    const source = inner.source;
    if (!StrKey.isValidEd25519PublicKey(source)) return reject("unregistered-source", "muxed or invalid source");
    if (!(await this.config.registry.isRegistered(source))) return reject("unregistered-source");
    if (!hasValidSignatureFrom(inner, source)) return reject("missing-source-signature");

    const maxTime = Number(inner.timeBounds?.maxTime ?? "0");
    const nowSec = Math.floor(this.clock.now() / 1000);
    if (maxTime === 0 || maxTime - nowSec > this.maxValidity) return reject("unbounded-validity");

    const soroban = isSorobanTx(inner);
    const fee = BigInt(inner.fee);
    const ops = inner.operations;
    if (soroban) {
      if (fee > this.caps.sorobanTotalFee) return reject("fee-above-cap", `soroban fee ${fee}`);
    } else if (ops.length > 0 && fee / BigInt(ops.length) > this.caps.classicFeePerOp) {
      return reject("fee-above-cap", `classic fee ${fee}`);
    }

    if (ops.length === 3) return this.sponsoredTrustline(ops, source);
    if (ops.length !== 1) return reject("operation-count", `${ops.length} operations`);
    const op = ops[0]!;

    if (op.type === "payment") return this.offramp(op, inner, source);
    if (op.type !== "invokeHostFunction") return reject("operation-not-allowed", op.type);

    const call = asContractCall(op);
    if (!call) return reject("operation-not-allowed", "non-call host function");
    if (call.source !== undefined && call.source !== source) return reject("foreign-op-source");
    if (!onlySourceAccountAuth(call.auth)) return reject("foreign-auth");
    const decision = await this.contractCall(call, source);
    return decision.allowed ? { ...decision, soroban: true } : decision;
  }

  private async contractCall(call: ContractCall, source: string): Promise<PolicyDecision> {
    const own = new Set(await this.config.registry.escrowsOf(source));

    if (call.contractId === this.config.guardContractId) {
      if (call.fn !== "contest") return reject("function-not-allowed", `guard.${call.fn}`);
      const escrow = scAddress(call.args[0]);
      if (call.args.length !== 2 || !escrow || !scBytesN(call.args[1], 32)) return reject("bad-arguments");
      if (!own.has(escrow)) return reject("not-own-escrow");
      return { allowed: true, action: { kind: "contest", escrow }, soroban: true };
    }

    if (!own.has(call.contractId)) {
      // Someone else's escrow or an unrelated contract (a direct SAC transfer included):
      // on-chain the two look alike, so both get the same answer.
      return reject("contract-not-allowed", call.contractId);
    }
    const escrow = call.contractId;
    switch (call.fn) {
      case "fund_escrow": {
        const signer = scAddress(call.args[0]);
        const amount = scI128(call.args[2]);
        if (call.args.length !== 3 || signer !== source || amount === null || amount <= 0n) return reject("bad-arguments");
        return { allowed: true, action: { kind: "fund_escrow", escrow, amount }, soroban: true };
      }
      case "approve_milestone": {
        const index = scU32(call.args[0]);
        const approver = scAddress(call.args[1]);
        if (call.args.length !== 2 || index === null || approver !== source) return reject("bad-arguments");
        return { allowed: true, action: { kind: "approve_milestone", escrow, milestoneIndex: index }, soroban: true };
      }
      case "dispute_escrow": {
        const signer = scAddress(call.args[0]);
        if (call.args.length !== 1 || signer !== source) return reject("bad-arguments");
        return { allowed: true, action: { kind: "dispute_escrow", escrow }, soroban: true };
      }
      default:
        return reject("function-not-allowed", `escrow.${call.fn}`);
    }
  }

  private sponsoredTrustline(ops: readonly OperationRecord[], source: string): PolicyDecision {
    const [begin, trust, end] = ops as [OperationRecord, OperationRecord, OperationRecord];
    if (begin.type !== "beginSponsoringFutureReserves" || trust.type !== "changeTrust" || end.type !== "endSponsoringFutureReserves") {
      return reject("operation-count", "3 operations that are not a sponsored-trustline sandwich");
    }
    if (begin.source !== this.config.sponsorPublicKey || begin.sponsoredId !== source) return reject("bad-arguments", "begin");
    if (trust.source !== undefined && trust.source !== source) return reject("foreign-op-source");
    if (end.source !== undefined && end.source !== source) return reject("foreign-op-source");
    if (!(trust.line instanceof Asset) || !trust.line.equals(this.config.eurc)) return reject("wrong-asset");
    if (trust.limit !== MAX_TRUST_LIMIT) return reject("bad-arguments", "trustline limit");
    return { allowed: true, action: { kind: "sponsored_trustline" }, soroban: false };
  }

  private async offramp(op: Operation.Payment, inner: Transaction, source: string): Promise<PolicyDecision> {
    if (op.source !== undefined && op.source !== source) return reject("foreign-op-source");
    if (!op.asset.equals(this.config.eurc)) return reject("wrong-asset");
    if (this.config.platformAddress !== undefined && op.destination === this.config.platformAddress) {
      return { allowed: true, action: { kind: "shipping_payment", destination: op.destination, amount: op.amount }, soroban: false };
    }
    const ramp = await this.config.registry.rampDestinationOf(source);
    if (!ramp || op.destination !== ramp.address) return reject("destination-not-allowed");
    const memo = inner.memo;
    if (ramp.memo) {
      // stellar-sdk 17 decodes text memos as bytes too: compare text as UTF-8, hash/return as hex.
      const value =
        memo.value === null
          ? ""
          : memo.value instanceof Uint8Array
            ? Buffer.from(memo.value).toString(memo.type === "text" ? "utf8" : "hex")
            : String(memo.value);
      if (memo.type !== ramp.memo.type || value !== ramp.memo.value) return reject("memo-mismatch");
    } else if (memo.type !== "none") {
      return reject("memo-mismatch", "ramp destination takes no memo");
    }
    return { allowed: true, action: { kind: "offramp_payment", destination: op.destination, amount: op.amount }, soroban: false };
  }
}
