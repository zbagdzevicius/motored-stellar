// SPDX-License-Identifier: Apache-2.0
//
// In-memory mirror of the guard contract's decisions (contracts/guard, v0.8), for
// the example only.
//
// The in-memory Trustless Work model in @motored-stellar/escrow treats the
// release signer and dispute resolver as plain addresses. On a network those
// roles belong to the guard contract, whose `__check_auth` decides whether a
// release or resolution may run. This file reproduces those decisions in
// TypeScript, with the contract's error codes, so the example can show every
// guard rule in action without a Soroban host:
//
//   check_escrow      roles, platform pin, receiver == service provider, zero
//                     balance, open flags, non-empty unapproved milestones;
//   register_escrow   buyer, seller, amount frozen at balance > 0; funded_at,
//                     approved_at, disputed_at recorded once each;
//   contest           the stored buyer only, inside the window;
//   __check_auth      Release | Resolve | ResolveSeller | BreakGlass branches.
//
// What it does not model: the Wasm hash pin and token pin (there is no Wasm
// here), Soroban's authorisation payload and nonce, and the fee-address argument
// of the testnet lineage. The Rust tests in contracts/guard run all of those
// against Trustless Work's deployed Wasm and are the source of truth; if this
// mirror and the contract ever disagree, the contract wins.

import { randomBytes } from 'node:crypto';
import { Keypair, StrKey } from '@stellar/stellar-sdk';
import { claimLeaf, type Claim, type RegistryClient } from '@motored-stellar/claims';
import type { EscrowSnapshot, Signer } from '@motored-stellar/escrow';

/** The guard contract's error codes (`GErr` in contracts/guard/src/lib.rs). */
export enum GuardErrorCode {
  NotRegistered = 1,
  WrongRole = 2,
  NotFunded = 3,
  Changed = 4,
  BadFn = 6,
  NoClaim = 8,
  BadRecipient = 9,
  TooEarly = 10,
  NotWholeToBuyer = 13,
  ClaimPredatesEscrow = 16,
  Closed = 17,
  AlreadySettled = 18,
  BadMilestone = 21,
  BadPlatform = 22,
  BadRoles = 23,
  NotEmpty = 24,
  Contested = 25,
  ContestTooLate = 26,
  NoDisputeSeen = 27,
  SellerOverAmount = 28,
}

export class GuardError extends Error {
  constructor(readonly code: GuardErrorCode) {
    super(`guard refused: ${GuardErrorCode[code]} (#${code})`);
    this.name = 'GuardError';
  }
}

/** Raised when a signature does not come from the branch's key (the contract traps in `ed25519_verify`). */
export class GuardAuthError extends Error {
  constructor(branch: string) {
    super(`guard refused: ${branch} signature is not from the pinned key (Error(Auth, InvalidAction))`);
    this.name = 'GuardAuthError';
  }
}

export interface GuardModelConfig {
  /** The guard's own address (C...): must be release_signer and dispute_resolver. */
  address: string;
  /** Platform fee account pinned per network. */
  platform: string;
  releaseKey: Uint8Array;
  resolverKey: Uint8Array;
  breakGlassKey: Uint8Array;
  /** Seconds a claim must be anchored before it pays the seller (7 days in production). */
  delay: number;
  /** Seconds the buyer has to contest after approval and dispute are both recorded (7 days). */
  contestWindow: number;
}

/** What the guard stores per escrow (`Reg`). */
export interface Registration {
  buyer: string;
  seller: string;
  amount: bigint;
  registeredAt: number;
  fundedAt?: number;
  approvedAt?: number;
  disputedAt?: number;
  contestedAt?: number;
  closed: boolean;
}

export type GuardCall =
  | { fn: 'release_funds' }
  | { fn: 'resolve_dispute'; distributions: ReadonlyArray<readonly [string, bigint]> }
  | { fn: 'withdraw_remaining_funds'; distributions: ReadonlyArray<readonly [string, bigint]> };

export type GuardSig =
  | { branch: 'Release'; signer: Signer }
  | { branch: 'Resolve'; signer: Signer }
  | { branch: 'ResolveSeller'; signer: Signer; claim: Claim }
  | { branch: 'BreakGlass'; signer: Signer };

const DAY = 86_400;

export class GuardModel {
  private readonly regs = new Map<string, Registration>();

  constructor(
    private readonly cfg: GuardModelConfig,
    private readonly registry: RegistryClient,
    private readonly now: () => number,
  ) {
    if (cfg.delay <= 0 || cfg.contestWindow <= 0) throw new RangeError('delays must be positive');
  }

  /** A production-shaped config: 7-day delay and contest window. */
  static sevenDays(cfg: Omit<GuardModelConfig, 'delay' | 'contestWindow'>): GuardModelConfig {
    return { ...cfg, delay: 7 * DAY, contestWindow: 7 * DAY };
  }

  registration(escrow: string): Registration | undefined {
    const r = this.regs.get(escrow);
    return r ? { ...r } : undefined;
  }

  /** `check_escrow`: run before any funding call is handed to the buyer. */
  checkEscrow(e: EscrowSnapshot): void {
    this.inspect(e);
    if (e.balance !== 0n) throw new GuardError(GuardErrorCode.NotEmpty);
    if (e.flags.disputed || e.flags.released || e.flags.resolved) throw new GuardError(GuardErrorCode.AlreadySettled);
    if (e.milestones.some((m) => m.status === '' || m.approved)) throw new GuardError(GuardErrorCode.BadMilestone);
  }

  /** `register_escrow`: permissionless register-or-refresh from on-chain state. */
  registerEscrow(e: EscrowSnapshot): Registration {
    this.inspect(e);
    if (e.flags.released || e.flags.resolved) throw new GuardError(GuardErrorCode.AlreadySettled);
    const now = this.now();
    let reg = this.regs.get(e.contractId);
    if (reg) {
      if (reg.buyer !== e.roles.approver || reg.seller !== e.roles.receiver || reg.amount !== e.amount) {
        throw new GuardError(GuardErrorCode.Changed);
      }
    } else {
      if (e.balance <= 0n) throw new GuardError(GuardErrorCode.NotFunded);
      reg = { buyer: e.roles.approver, seller: e.roles.receiver, amount: e.amount, registeredAt: now, closed: false };
    }
    if (!reg.closed) {
      if (reg.fundedAt === undefined && e.balance >= reg.amount) reg.fundedAt = now;
      if (reg.approvedAt === undefined && e.milestones.length > 0 && e.milestones.every((m) => m.approved)) reg.approvedAt = now;
      if (reg.disputedAt === undefined && e.flags.disputed) reg.disputedAt = now;
    }
    this.regs.set(e.contractId, reg);
    return { ...reg };
  }

  /** `contest`: the stored buyer switches off the claimless seller path. */
  contest(escrow: string, buyer: string): void {
    const reg = this.regs.get(escrow);
    if (!reg) throw new GuardError(GuardErrorCode.NotRegistered);
    if (buyer !== reg.buyer) throw new GuardAuthError('contest (buyer)');
    if (reg.closed) throw new GuardError(GuardErrorCode.Closed);
    const start = windowStart(reg);
    if (start !== undefined && this.now() >= start + this.cfg.contestWindow) throw new GuardError(GuardErrorCode.ContestTooLate);
    reg.contestedAt ??= this.now();
  }

  /**
   * `__check_auth` for one call on `escrow`. Throws `GuardError` or
   * `GuardAuthError` when the contract would refuse; marks the registration
   * closed after an authorised release or resolution, as the contract does.
   */
  async authorize(escrow: string, call: GuardCall, sig: GuardSig): Promise<void> {
    const reg = this.regs.get(escrow);
    if (!reg) throw new GuardError(GuardErrorCode.NotRegistered);

    switch (sig.branch) {
      case 'BreakGlass': {
        if (call.fn !== 'resolve_dispute') throw new GuardError(GuardErrorCode.BadFn);
        await verifyKey(sig.signer, this.cfg.breakGlassKey, 'BreakGlass');
        const d = call.distributions;
        if (d.length !== 1 || d[0]![0] !== reg.buyer) throw new GuardError(GuardErrorCode.NotWholeToBuyer);
        reg.closed = true;
        return;
      }
      case 'Release': {
        if (call.fn !== 'release_funds') throw new GuardError(GuardErrorCode.BadFn);
        if (reg.closed) throw new GuardError(GuardErrorCode.Closed);
        await verifyKey(sig.signer, this.cfg.releaseKey, 'Release');
        reg.closed = true;
        return;
      }
      case 'Resolve':
      case 'ResolveSeller': {
        if (call.fn === 'release_funds') throw new GuardError(GuardErrorCode.BadFn);
        await verifyKey(sig.signer, this.cfg.resolverKey, sig.branch);
        const d = call.distributions;
        if (call.fn === 'withdraw_remaining_funds') {
          if (d.some(([a]) => a !== reg.buyer)) throw new GuardError(GuardErrorCode.BadRecipient);
          return;
        }
        if (reg.closed) throw new GuardError(GuardErrorCode.Closed);
        let toSeller = false;
        for (const [a, amount] of d) {
          if (a === reg.seller) {
            toSeller = true;
            if (amount > reg.amount) throw new GuardError(GuardErrorCode.SellerOverAmount);
          } else if (a !== reg.buyer) {
            throw new GuardError(GuardErrorCode.BadRecipient);
          }
        }
        if (toSeller) {
          if (reg.fundedAt === undefined) throw new GuardError(GuardErrorCode.NotFunded);
          const now = this.now();
          if (sig.branch === 'ResolveSeller') {
            // (a) Silent buyer: a claim for THIS escrow, anchored after full funding, `delay` old.
            const c = sig.claim;
            const ok = await this.registry.verify(c.batchId, claimLeaf(escrow, c), c.proof, c.index);
            if (!ok) throw new GuardError(GuardErrorCode.NoClaim);
            const at = Number(await this.registry.anchoredAt(c.batchId));
            if (at <= reg.fundedAt) throw new GuardError(GuardErrorCode.ClaimPredatesEscrow);
            if (now < at + this.cfg.delay) throw new GuardError(GuardErrorCode.TooEarly);
          } else {
            // (b) Buyer approved, a dispute blocked release, no contest within the window.
            if (reg.approvedAt === undefined) throw new GuardError(GuardErrorCode.NoClaim);
            if (reg.disputedAt === undefined) throw new GuardError(GuardErrorCode.NoDisputeSeen);
            if (reg.contestedAt !== undefined) throw new GuardError(GuardErrorCode.Contested);
            if (now < windowStart(reg)! + this.cfg.contestWindow) throw new GuardError(GuardErrorCode.TooEarly);
          }
        }
        reg.closed = true;
        return;
      }
    }
  }

  private inspect(e: EscrowSnapshot): void {
    if (e.roles.releaseSigner !== this.cfg.address || e.roles.disputeResolver !== this.cfg.address) {
      throw new GuardError(GuardErrorCode.WrongRole);
    }
    if (e.roles.platform !== this.cfg.platform) throw new GuardError(GuardErrorCode.BadPlatform);
    if (e.roles.receiver !== e.roles.serviceProvider) throw new GuardError(GuardErrorCode.BadRoles);
  }
}

function windowStart(r: Registration): number | undefined {
  return r.approvedAt !== undefined && r.disputedAt !== undefined ? Math.max(r.approvedAt, r.disputedAt) : undefined;
}

/**
 * Mirrors `ed25519_verify(pinned_key, payload, sig)`: the signer signs a fresh
 * payload and the signature must verify under the pinned key.
 */
async function verifyKey(signer: Signer, pinned: Uint8Array, branch: string): Promise<void> {
  const payload = new Uint8Array(randomBytes(32));
  const sig = await signer.signAuthPayload(payload);
  if (!verifyRaw(pinned, payload, sig)) throw new GuardAuthError(branch);
}

function verifyRaw(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  try {
    const kp = Keypair.fromPublicKey(StrKey.encodeEd25519PublicKey(Buffer.from(publicKey)));
    return kp.verify(Buffer.from(message), Buffer.from(signature));
  } catch {
    return false;
  }
}
