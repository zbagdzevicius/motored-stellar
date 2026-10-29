// SPDX-License-Identifier: Apache-2.0
//
// Authorization entries for the escrow guard, a Soroban custom account
// (`__check_auth`) that holds the escrow's `release_signer` and
// `dispute_resolver` roles. When the escrow calls `release_signer.require_auth()`
// the host invokes the guard's `__check_auth(payload, sig, ctx)`; `sig` is the
// `GuardSig` value we put in the entry's credentials, and its ed25519 signature
// must cover Soroban's authorization payload:
//
//   payload = sha256(XDR(HashIdPreimage::EnvelopeTypeSorobanAuthorization {
//               network_id = sha256(passphrase), nonce, signature_expiration_ledger,
//               invocation }))
//
// so the signature is bound to one network, one nonce and one invocation
// (contract, function and arguments) and cannot be replayed.
//
// Ported from arch8.mjs (`signEntry`, `guardSig`, `claimVal`, `leaf`) and
// guardcall.js (record-simulate, sign, then re-simulate in enforce mode).

import { createHash } from 'node:crypto';
import { Address, hash, xdr } from '@stellar/stellar-sdk';
import type { Signer } from './ports.js';
import { addr, bytes, struct, sym, u32, u64, vec } from './scval.js';

/** Which `__check_auth` branch, and therefore which key, a signature is for. */
export type GuardBranch = 'Release' | 'Resolve' | 'ResolveSeller' | 'BreakGlass';

/**
 * A delivery claim as the guard's `Claim` struct takes it. The leaf commits to the
 * escrow address, so a claim for one escrow never pays another.
 */
export interface DeliveryClaim {
  /** Random 32-byte order reference. */
  orderRef: Uint8Array;
  /** HMAC-SHA256(per-order salt, parcel number). */
  parcelsCommit: Uint8Array;
  /** sha256 of the carrier's authenticated delivery event. */
  carrierEventRef: Uint8Array;
  /** Unix seconds; platform-written, not used for timing by the guard. */
  deliveredAt: bigint;
  batchId: bigint;
  /** Sibling hashes, leaf level first. At most 32. */
  proof: Uint8Array[];
  /** Leaf index; bit i set means the running hash is the right child at level i. */
  index: number;
}

const TAG_LEAF = 0x01;
const TAG_NODE = 0x02;
const sha256 = (b: Uint8Array): Buffer => createHash('sha256').update(b).digest();

function check32(name: string, b: Uint8Array): void {
  if (b.length !== 32) throw new RangeError(`${name} must be 32 bytes, got ${b.length}`);
}

/**
 * Delivery-claim leaf, byte-identical to the guard's `leaf()`:
 * `sha256(0x01 || XDR(ScVal::Address(escrow)) || order_ref || parcels_commit || carrier_event_ref || u64_be(delivered_at))`.
 */
export function deliveryClaimLeaf(escrowContractId: string, c: Pick<DeliveryClaim, 'orderRef' | 'parcelsCommit' | 'carrierEventRef' | 'deliveredAt'>): Buffer {
  check32('orderRef', c.orderRef);
  check32('parcelsCommit', c.parcelsCommit);
  check32('carrierEventRef', c.carrierEventRef);
  const be = Buffer.alloc(8);
  be.writeBigUInt64BE(c.deliveredAt);
  return sha256(
    Buffer.concat([Buffer.from([TAG_LEAF]), addr(escrowContractId).toXDR(), c.orderRef, c.parcelsCommit, c.carrierEventRef, be]),
  );
}

/** Root reached from `leaf` by `proof` at `index` (`node = sha256(0x02 || left || right)`). */
export function rootFromProof(leaf: Uint8Array, proof: readonly Uint8Array[], index: number): Buffer {
  if (proof.length > 32) throw new RangeError('proof depth is capped at 32');
  let h: Buffer = Buffer.from(leaf);
  let i = BigInt(index >>> 0);
  for (const sib of proof) {
    check32('proof node', sib);
    h = (i & 1n) === 1n
      ? sha256(Buffer.concat([Buffer.from([TAG_NODE]), sib, h]))
      : sha256(Buffer.concat([Buffer.from([TAG_NODE]), h, sib]));
    i >>= 1n;
  }
  return h;
}

/** The guard's `Claim` struct. */
export function claimToScVal(c: DeliveryClaim): xdr.ScVal {
  return struct({
    batch_id: u64(c.batchId),
    carrier_event_ref: bytes(c.carrierEventRef),
    delivered_at: u64(c.deliveredAt),
    index: u32(c.index),
    order_ref: bytes(c.orderRef),
    parcels_commit: bytes(c.parcelsCommit),
    proof: vec(c.proof.map(bytes)),
  });
}

/**
 * The `GuardSig` enum value: `Release(sig)`, `Resolve(sig)`, `BreakGlass(sig)`
 * or `ResolveSeller(ResolveSig { sig, claim })`. Soroban encodes an enum variant
 * as a vec of its name followed by its payload.
 */
export function guardSignatureScVal(branch: GuardBranch, signature: Uint8Array, claim?: DeliveryClaim): xdr.ScVal {
  if (signature.length !== 64) throw new RangeError('ed25519 signature must be 64 bytes');
  if (branch === 'ResolveSeller') {
    if (!claim) throw new Error('ResolveSeller needs a delivery claim');
    return vec([sym('ResolveSeller'), struct({ claim: claimToScVal(claim), sig: bytes(signature) })]);
  }
  return vec([sym(branch), bytes(signature)]);
}

/**
 * The address credentials of an entry and which variant carries them. Testnet RPC
 * returned the legacy `sorobanCredentialsAddress` in runs 4 to 6 and
 * `sorobanCredentialsAddressV2` (CAP-71) from run 7, 29 Oct 2026. Both carry the same
 * `SorobanAddressCredentials`; V2 binds the address into the signed preimage.
 * Null for source-account credentials and for credentials with delegates.
 */
export function addressCredentialsOf(
  entry: xdr.SorobanAuthorizationEntry,
): { creds: xdr.SorobanAddressCredentials; v2: boolean } | null {
  const cred = entry.credentials;
  if (cred.type === 'sorobanCredentialsAddress') return { creds: cred.address, v2: false };
  if (cred.type === 'sorobanCredentialsAddressV2') return { creds: cred.addressV2, v2: true };
  return null;
}

/** `entry` with its address credentials replaced by `creds` plus `patch`, in the same variant. */
function withAddressCredentials(
  entry: xdr.SorobanAuthorizationEntry,
  creds: xdr.SorobanAddressCredentials,
  v2: boolean,
  patch: { signatureExpirationLedger: number; signature?: xdr.ScVal },
): xdr.SorobanAuthorizationEntry {
  const next = new xdr.SorobanAddressCredentials({
    address: creds.address,
    nonce: creds.nonce,
    signatureExpirationLedger: patch.signatureExpirationLedger,
    signature: patch.signature ?? creds.signature,
  });
  return new xdr.SorobanAuthorizationEntry({
    credentials: v2 ? xdr.SorobanCredentials.sorobanCredentialsAddressV2(next) : xdr.SorobanCredentials.sorobanCredentialsAddress(next),
    rootInvocation: entry.rootInvocation,
  });
}

/** Copies an entry so signing never mutates a simulation result. Accepts base64 too. */
export function cloneAuthEntry(entry: xdr.SorobanAuthorizationEntry | string): xdr.SorobanAuthorizationEntry {
  return typeof entry === 'string'
    ? xdr.SorobanAuthorizationEntry.fromXdr(entry, 'base64')
    : xdr.SorobanAuthorizationEntry.fromXdr(entry.toXdr());
}

/**
 * The authorization payload hash of an address-credentialed entry (expiration already set).
 * Legacy entries hash `ENVELOPE_TYPE_SOROBAN_AUTHORIZATION`; V2 entries hash
 * `ENVELOPE_TYPE_SOROBAN_AUTHORIZATION_WITH_ADDRESS`, which also commits to the address.
 */
export function authorizationPayload(entry: xdr.SorobanAuthorizationEntry, networkPassphrase: string): Buffer {
  const found = addressCredentialsOf(entry);
  if (!found) throw new Error(`entry has ${entry.credentials.type} credentials, not address credentials`);
  const { creds, v2 } = found;
  const networkId = hash(Buffer.from(networkPassphrase));
  const preimage = v2
    ? xdr.HashIdPreimage.envelopeTypeSorobanAuthorizationWithAddress(
        new xdr.HashIdPreimageSorobanAuthorizationWithAddress({
          networkId,
          nonce: creds.nonce,
          signatureExpirationLedger: creds.signatureExpirationLedger,
          address: creds.address,
          invocation: entry.rootInvocation,
        }),
      )
    : xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
        new xdr.HashIdPreimageSorobanAuthorization({
          networkId,
          nonce: creds.nonce,
          signatureExpirationLedger: creds.signatureExpirationLedger,
          invocation: entry.rootInvocation,
        }),
      );
  return Buffer.from(hash(preimage.toXdr()));
}

/** Contract, function and arguments an entry authorizes at its root. */
export function describeAuthEntry(entry: xdr.SorobanAuthorizationEntry): { address?: string; contractId: string; fn: string; args: xdr.ScVal[] } {
  const fn = entry.rootInvocation.function;
  if (fn.type !== 'sorobanAuthorizedFunctionTypeContractFn') throw new Error('entry does not authorize a contract call');
  const call = fn.contractFn;
  const found = addressCredentialsOf(entry);
  return {
    address: found ? Address.fromScAddress(found.creds.address).toString() : undefined,
    contractId: Address.fromScAddress(call.contractAddress).toString(),
    fn: call.functionName.toString(),
    args: call.args,
  };
}

export interface GuardSigningOptions {
  guardContractId: string;
  networkPassphrase: string;
  /** Last ledger at which the signature is valid. */
  validUntilLedger: number;
  /** The guard key for the chosen branch (release, resolver or break-glass). */
  key: Signer;
  branch: GuardBranch;
  claim?: DeliveryClaim;
  /** If set, refuse to sign unless the root invocation is exactly this contract and function. */
  expect?: { contractId: string; fn: string };
}

/**
 * Signs every address-credentialed entry (legacy or V2, kept in the variant it
 * arrived in) whose address is the guard; other
 * entries are returned unchanged (copied). Throws if no entry is for the guard,
 * or if `expect` is given and an entry authorizes a different call.
 */
export async function signGuardEntries(
  entries: ReadonlyArray<xdr.SorobanAuthorizationEntry | string>,
  opts: GuardSigningOptions,
): Promise<xdr.SorobanAuthorizationEntry[]> {
  let signed = 0;
  const out: xdr.SorobanAuthorizationEntry[] = [];
  for (const e0 of entries) {
    const e = cloneAuthEntry(e0);
    const found = addressCredentialsOf(e);
    if (!found) {
      out.push(e);
      continue;
    }
    const { creds, v2 } = found;
    if (Address.fromScAddress(creds.address).toString() !== opts.guardContractId) {
      out.push(e);
      continue;
    }
    if (opts.expect) {
      const d = describeAuthEntry(e);
      if (d.contractId !== opts.expect.contractId || d.fn !== opts.expect.fn) {
        throw new Error(`guard entry authorizes ${d.contractId}.${d.fn}, expected ${opts.expect.contractId}.${opts.expect.fn}`);
      }
    }
    // XDR values are immutable since stellar-sdk 17: rebuild the entry with the
    // expiration set, hash that, then rebuild it again with the signature.
    const withExpiry = withAddressCredentials(e, creds, v2, { signatureExpirationLedger: opts.validUntilLedger });
    const payload = authorizationPayload(withExpiry, opts.networkPassphrase);
    const sig = await opts.key.signAuthPayload(payload);
    out.push(
      withAddressCredentials(e, creds, v2, {
        signatureExpirationLedger: opts.validUntilLedger,
        signature: guardSignatureScVal(opts.branch, sig, opts.claim),
      }),
    );
    signed += 1;
  }
  if (signed === 0) throw new Error(`no authorization entry for guard ${opts.guardContractId}`);
  return out;
}
