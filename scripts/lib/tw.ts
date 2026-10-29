/**
 * Trustless Work v1 single-release escrow, as called directly on the contract.
 *
 * Contract-level entry points and argument order are the ones the lab exercised
 * against Trustless Work's own testnet Wasm (7c3f7b2a..., see
 * docs/verification.md): `tw_new_single_release_escrow` (atomic deploy + init
 * through the contract's deployer entry point), `initialize_escrow`,
 * `get_escrow`, `fund_escrow(signer, expected_escrow, amount)`,
 * `approve_milestone(index, approver)`, `dispute_escrow(signer)`,
 * `release_funds(release_signer, trustless_work_address)` and
 * `resolve_dispute(dispute_resolver, trustless_work_address, distributions)`.
 * The escrow struct mirrors Trustless Work's `storage/types.rs` (commit 6e4d40e),
 * the same mirror the guard decodes.
 *
 * The Wasm is not vendored: contracts/third_party/tw-wasm/fetch.sh fetches it by hash.
 */
import { randomBytes } from 'node:crypto';
import type { xdr } from '@stellar/stellar-sdk';
import { addr, bool, i128, map, str, u32, vec } from './scval.js';

/** Trustless Work single-release v1 Wasm hashes the guard pins. */
export const TW_WASM_HASH = {
  testnet: '7c3f7b2af92ad86092708b23babf80f9e1308d7f3ce18b703b9499192ecc934b',
  /** Documented reference only; nothing in this repo deploys to mainnet. */
  mainnet: '96d51751f924c938a081deb740056dc1c5cc60c6e645672062531f82957ed2fe',
} as const;

export interface EscrowRoles {
  /** Buyer: the only party that can approve the milestone. */
  approver: string;
  /** Seller. The guard requires receiver == service_provider. */
  serviceProvider: string;
  receiver: string;
  /** Platform fee account. */
  platform: string;
  /** The guard contract, in both signing roles. */
  releaseSigner: string;
  disputeResolver: string;
}

export interface EscrowParams {
  roles: EscrowRoles;
  /** Escrow amount in the token's 7-decimal units. */
  amount: bigint;
  /** Platform fee in basis points (the lab used 470). */
  platformFeeBps: number;
  /** Token contract (EURC SAC on mainnet, stand-in XEUR SAC on testnet). */
  token: string;
  /** Random per escrow; generic text fields carry no personal data. */
  engagementId?: string;
}

/** The `Escrow` value passed to `initialize_escrow`, with generic text fields. */
export function escrowValue(p: EscrowParams): xdr.ScVal {
  return map({
    amount: i128(p.amount),
    description: str('part'),
    engagement_id: str(p.engagementId ?? randomBytes(8).toString('hex')),
    flags: map({ disputed: bool(false), released: bool(false), resolved: bool(false) }),
    // TW v1: an empty milestone status can never be changed or approved, so it is always set.
    milestones: vec([map({ approved: bool(false), description: str('part delivered'), evidence: str(''), status: str('awaiting delivery') })]),
    platform_fee: u32(p.platformFeeBps),
    receiver_memo: u32(0),
    roles: map({
      approver: addr(p.roles.approver),
      dispute_resolver: addr(p.roles.disputeResolver),
      platform: addr(p.roles.platform),
      receiver: addr(p.roles.receiver),
      release_signer: addr(p.roles.releaseSigner),
      service_provider: addr(p.roles.serviceProvider),
    }),
    title: str('order'),
    trustline: map({ address: addr(p.token) }),
  });
}

/** Guard contract error codes (contracts/guard GErr), for readable logs. */
export const GUARD_ERRORS: Record<number, string> = {
  1: 'NotRegistered', 2: 'WrongRole', 3: 'NotFunded', 4: 'Changed', 5: 'BadContext', 6: 'BadFn',
  8: 'NoClaim', 9: 'BadRecipient', 10: 'TooEarly', 11: 'BadToken', 12: 'BadWasm',
  13: 'NotWholeToBuyer', 14: 'BadArgs', 15: 'BadFeeAddr', 16: 'ClaimPredatesEscrow', 17: 'Closed',
  18: 'AlreadySettled', 19: 'NoPending', 20: 'Timelocked', 21: 'BadMilestone',
  22: 'BadPlatform', 23: 'BadRoles', 24: 'NotEmpty', 25: 'Contested', 26: 'ContestTooLate', 27: 'NoDisputeSeen', 28: 'SellerOverAmount',
};
