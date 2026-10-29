// SPDX-License-Identifier: Apache-2.0
//
// The Trustless Work v1 single-release `Escrow` struct as stored on-chain and as
// carried by its events (`tw_init`, `tw_update`, `tw_ms_approve`, `tw_dispute`,
// `tw_disp_resolve`). Field names and types match the contract's `contracttype`
// (and the guard's mirror type), so the encoder below produces exactly the value
// `initialize_escrow` and `fund_escrow(expected_escrow)` take.

import { scValToNative, xdr } from '@stellar/stellar-sdk';
import { addr, bool, i128, str, struct, u32, vec } from './scval.js';

export interface EscrowRoles {
  /** Buyer wallet: approves the milestone. */
  approver: string;
  /** Seller wallet: fulfils; may change the milestone status or open a dispute. */
  serviceProvider: string;
  /** Platform fee account. */
  platform: string;
  /** Guard contract (C-address) in the guarded model. */
  releaseSigner: string;
  /** Guard contract (C-address) in the guarded model. */
  disputeResolver: string;
  /** Seller's own wallet. Must equal `serviceProvider` for the guard. */
  receiver: string;
}

export interface EscrowMilestone {
  description: string;
  /** Must be non-empty: an empty status can never be changed or approved in v1. */
  status: string;
  evidence: string;
  approved: boolean;
}

export interface EscrowFlags {
  disputed: boolean;
  released: boolean;
  resolved: boolean;
}

export interface OnChainEscrow {
  engagementId: string;
  title: string;
  description: string;
  roles: EscrowRoles;
  /** 7-decimal units. */
  amount: bigint;
  platformFeeBps: number;
  milestones: EscrowMilestone[];
  flags: EscrowFlags;
  /** Token contract (SAC) address. */
  trustline: string;
  receiverMemo: number;
}

/** An escrow read back with its contract ID and current token balance. */
export interface EscrowSnapshot extends OnChainEscrow {
  contractId: string;
  balance: bigint;
}

/** Encodes an escrow as the contract's `Escrow` struct. */
export function escrowToScVal(e: OnChainEscrow): xdr.ScVal {
  return struct({
    amount: i128(e.amount),
    description: str(e.description),
    engagement_id: str(e.engagementId),
    flags: struct({ disputed: bool(e.flags.disputed), released: bool(e.flags.released), resolved: bool(e.flags.resolved) }),
    milestones: vec(
      e.milestones.map((m) =>
        struct({ approved: bool(m.approved), description: str(m.description), evidence: str(m.evidence), status: str(m.status) }),
      ),
    ),
    platform_fee: u32(e.platformFeeBps),
    receiver_memo: u32(e.receiverMemo),
    roles: struct({
      approver: addr(e.roles.approver),
      dispute_resolver: addr(e.roles.disputeResolver),
      platform: addr(e.roles.platform),
      receiver: addr(e.roles.receiver),
      release_signer: addr(e.roles.releaseSigner),
      service_provider: addr(e.roles.serviceProvider),
    }),
    title: str(e.title),
    trustline: struct({ address: addr(e.trustline) }),
  });
}

type NativeRecord = Record<string, unknown>;

function rec(v: unknown, what: string): NativeRecord {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new TypeError(`${what}: expected a struct`);
  return v as NativeRecord;
}
function s(v: unknown, what: string): string {
  if (typeof v !== 'string') throw new TypeError(`${what}: expected a string`);
  return v;
}
function b(v: unknown, what: string): boolean {
  if (typeof v !== 'boolean') throw new TypeError(`${what}: expected a bool`);
  return v;
}
function n(v: unknown, what: string): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  throw new TypeError(`${what}: expected an integer`);
}
function big(v: unknown, what: string): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isInteger(v)) return BigInt(v);
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return BigInt(v);
  throw new TypeError(`${what}: expected an i128`);
}

/** Decodes the output of `scValToNative` on an `Escrow` struct. */
export function escrowFromNative(native: unknown): OnChainEscrow {
  const e = rec(native, 'escrow');
  const roles = rec(e.roles, 'roles');
  const flags = rec(e.flags, 'flags');
  const trustline = rec(e.trustline, 'trustline');
  if (!Array.isArray(e.milestones)) throw new TypeError('milestones: expected a vec');
  return {
    engagementId: s(e.engagement_id, 'engagement_id'),
    title: s(e.title, 'title'),
    description: s(e.description, 'description'),
    roles: {
      approver: s(roles.approver, 'roles.approver'),
      serviceProvider: s(roles.service_provider, 'roles.service_provider'),
      platform: s(roles.platform, 'roles.platform'),
      releaseSigner: s(roles.release_signer, 'roles.release_signer'),
      disputeResolver: s(roles.dispute_resolver, 'roles.dispute_resolver'),
      receiver: s(roles.receiver, 'roles.receiver'),
    },
    amount: big(e.amount, 'amount'),
    platformFeeBps: n(e.platform_fee, 'platform_fee'),
    milestones: e.milestones.map((m, i) => {
      const r = rec(m, `milestones[${i}]`);
      return {
        description: s(r.description, 'milestone.description'),
        status: s(r.status, 'milestone.status'),
        evidence: s(r.evidence, 'milestone.evidence'),
        approved: b(r.approved, 'milestone.approved'),
      };
    }),
    flags: {
      disputed: b(flags.disputed, 'flags.disputed'),
      released: b(flags.released, 'flags.released'),
      resolved: b(flags.resolved, 'flags.resolved'),
    },
    trustline: s(trustline.address, 'trustline.address'),
    receiverMemo: n(e.receiver_memo, 'receiver_memo'),
  };
}

/** Decodes an `Escrow` ScVal (for example the return value of `get_escrow`). */
export function escrowFromScVal(v: xdr.ScVal): OnChainEscrow {
  return escrowFromNative(scValToNative(v));
}

/** Compares the fields that define an escrow (everything except balance). */
export function sameEscrowProperties(a: OnChainEscrow, b2: OnChainEscrow): boolean {
  return escrowToScVal(a).toXDR('base64') === escrowToScVal(b2).toXDR('base64');
}
