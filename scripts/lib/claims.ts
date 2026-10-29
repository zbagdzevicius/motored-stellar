/**
 * Delivery-claim leaf and Merkle tree, byte-compatible with the guard's `leaf()`
 * and the claim registry's `verify()` (contracts/guard, contracts/claim-registry).
 *
 *   leaf = sha256(0x01 || XDR(ScVal::Address(E)) || order_ref || parcels_commit
 *                 || carrier_event_ref || u64_be(delivered_at))
 *   node = sha256(0x02 || left || right)
 *
 * Bit k of `index` (lowest first) says whether the running hash is the right
 * child at depth k; a proof is valid only when every bit is consumed.
 * `carrier_event_ref` had a carrier-specific name in the lab; the byte layout is unchanged.
 *
 * This module is the scripts' own copy so the CLIs run without the rest of the
 * workspace. scripts/test/shared-vectors.test.ts pins it to the golden vectors in
 * packages/claims/test/vectors.json, which the Rust guard tests also assert.
 */
import { createHash, createHmac } from 'node:crypto';
import { Address, xdr } from '@stellar/stellar-sdk';
import { bytes, map, u32, u64, vec } from './scval.js';

export const TAG_CLAIM_LEAF = 0x01;
export const TAG_NODE = 0x02;
/**
 * Padding leaf tag: pad_leaf(i) = sha256(0x03 || u32_be(i)), the rule Open Part
 * Passport and packages/claims (merkle.ts) use. Padding is a batch-builder
 * choice: verification on-chain never sees it.
 */
export const TAG_PAD = 0x03;
/** The registry rejects longer proofs (MAX_DEPTH). */
export const MAX_DEPTH = 32;

export const sha256 = (b: Uint8Array): Buffer => createHash('sha256').update(b).digest();

export interface DeliveryClaim {
  /** Random 32 bytes per order, never a database ID. */
  orderRef: Buffer;
  /** HMAC-SHA256(per-order secret salt kept off-chain, carrier parcel number). */
  parcelsCommit: Buffer;
  /** sha256 of the carrier's authenticated delivered event. */
  carrierEventRef: Buffer;
  /** Unix seconds of the carrier's delivered event. */
  deliveredAt: bigint;
}

/** A claim placed in an anchored batch: what the guard's ResolveSeller branch and the public re-check need. */
export interface AnchoredClaim extends DeliveryClaim {
  escrow: string;
  batchId: bigint;
  proof: Buffer[];
  index: number;
}

function check32(name: string, b: Buffer): void {
  if (b.length !== 32) throw new Error(`${name} must be 32 bytes, got ${b.length}`);
}

/** XDR of ScVal::Address(E): what the guard appends with `escrow.to_xdr(env)`. */
export const addressXdr = (escrow: string): Buffer => Buffer.from(new Address(escrow).toScVal().toXdr());

export function claimLeaf(escrow: string, c: DeliveryClaim): Buffer {
  check32('order_ref', c.orderRef);
  check32('parcels_commit', c.parcelsCommit);
  check32('carrier_event_ref', c.carrierEventRef);
  if (c.deliveredAt < 0n || c.deliveredAt > 0xffff_ffff_ffff_ffffn) throw new Error('delivered_at out of u64 range');
  const be = Buffer.alloc(8);
  be.writeBigUInt64BE(c.deliveredAt);
  return sha256(Buffer.concat([Buffer.from([TAG_CLAIM_LEAF]), addressXdr(escrow), c.orderRef, c.parcelsCommit, c.carrierEventRef, be]));
}

export const nodeHash = (l: Buffer, r: Buffer): Buffer => sha256(Buffer.concat([Buffer.from([TAG_NODE]), l, r]));

export function padLeaf(i: number): Buffer {
  const b = Buffer.alloc(5);
  b[0] = TAG_PAD;
  b.writeUInt32BE(i, 1);
  return sha256(b);
}

/** parcels_commit = HMAC-SHA256(salt, parcel number). The salt never leaves the platform. */
export function parcelsCommitment(salt: Buffer, parcelNumber: string): Buffer {
  if (salt.length < 32) throw new Error('salt must be at least 32 bytes');
  return createHmac('sha256', salt).update(parcelNumber, 'utf8').digest();
}

/** Smallest power of two >= n (and >= 1). */
export function batchSize(n: number): number {
  let s = 1;
  while (s < n) s <<= 1;
  return s;
}

/** All tree levels, bottom first, padded to a power of two. */
export function buildTree(leaves: Buffer[], size = batchSize(leaves.length)): Buffer[][] {
  if (size < 1 || (size & (size - 1)) !== 0) throw new Error('size must be a power of two');
  if (leaves.length > size) throw new Error('too many leaves for batch size');
  const level0 = [...leaves];
  for (let i = leaves.length; i < size; i++) level0.push(padLeaf(i));
  const levels = [level0];
  for (let cur = level0; cur.length > 1; ) {
    const next: Buffer[] = [];
    for (let i = 0; i < cur.length; i += 2) next.push(nodeHash(cur[i] as Buffer, cur[i + 1] as Buffer));
    levels.push(next);
    cur = next;
  }
  if (levels.length - 1 > MAX_DEPTH) throw new Error('tree deeper than the registry accepts');
  return levels;
}

export const rootOf = (levels: Buffer[][]): Buffer => (levels[levels.length - 1] as Buffer[])[0] as Buffer;

export function proofOf(levels: Buffer[][], index: number): Buffer[] {
  const proof: Buffer[] = [];
  let i = index;
  for (let d = 0; d < levels.length - 1; d++) {
    proof.push((levels[d] as Buffer[])[i ^ 1] as Buffer);
    i >>= 1;
  }
  return proof;
}

/**
 * Places a batch tree under further levels so the proof reaches `depth`
 * (at most MAX_DEPTH). Each extra level gets one sibling from `filler`, which
 * stands in for the rest of a larger tree (other batches' roots). The index
 * keeps its value, so its higher bits are 0 and the claim's subtree is always
 * the left child above the batch. Returns the deeper proof and the root to anchor.
 * The guard and the registry walk the full proof, so this exercises the
 * depth-32 verification cost on-chain without a 2^32-leaf batch.
 */
export function deepenProof(levels: Buffer[][], index: number, depth: number, filler: (level: number) => Buffer): { proof: Buffer[]; root: Buffer } {
  const base = proofOf(levels, index);
  if (!Number.isInteger(depth) || depth < base.length || depth > MAX_DEPTH) throw new Error(`depth must be between ${base.length} and ${MAX_DEPTH}`);
  const proof = [...base];
  let h = rootOf(levels);
  for (let d = base.length; d < depth; d++) {
    const sib = filler(d);
    check32(`filler[${d}]`, sib);
    proof.push(sib);
    h = nodeHash(h, sib);
  }
  return { proof, root: h };
}

/** Walks a proof the way the registry does and returns the computed root, or null if `index` has bits left. */
export function walkProof(leaf: Buffer, proof: Buffer[], index: number): Buffer | null {
  if (proof.length > MAX_DEPTH) return null;
  let h = leaf;
  let i = BigInt(index >>> 0);
  for (const sib of proof) {
    h = i & 1n ? nodeHash(sib, h) : nodeHash(h, sib);
    i >>= 1n;
  }
  return i === 0n ? h : null;
}

export function verifyProof(leaf: Buffer, proof: Buffer[], index: number, root: Buffer): boolean {
  const r = walkProof(leaf, proof, index);
  return r !== null && r.equals(root);
}

/** The guard's `Claim` struct (fields sorted by name). */
export function claimToScVal(c: AnchoredClaim): xdr.ScVal {
  return map({
    batch_id: u64(c.batchId),
    carrier_event_ref: bytes(c.carrierEventRef),
    delivered_at: u64(c.deliveredAt),
    index: u32(c.index),
    order_ref: bytes(c.orderRef),
    parcels_commit: bytes(c.parcelsCommit),
    proof: vec(c.proof.map((p) => bytes(p))),
  });
}

/** Public JSON form of a claim, as published for re-checking. Contains no salts and no parcel numbers. */
export interface ClaimFile {
  format: 'motored-delivery-claim/v1';
  network: 'testnet' | 'mainnet';
  registry: string;
  escrow: string;
  order_ref: string;
  parcels_commit: string;
  carrier_event_ref: string;
  delivered_at: string;
  batch_id: string;
  index: number;
  proof: string[];
}

const hex32 = (name: string, s: string): Buffer => {
  if (!/^[0-9a-f]{64}$/i.test(s)) throw new Error(`${name}: expected 64 hex chars`);
  return Buffer.from(s, 'hex');
};

export function claimToFile(c: AnchoredClaim, network: ClaimFile['network'], registry: string): ClaimFile {
  return {
    format: 'motored-delivery-claim/v1',
    network,
    registry,
    escrow: c.escrow,
    order_ref: c.orderRef.toString('hex'),
    parcels_commit: c.parcelsCommit.toString('hex'),
    carrier_event_ref: c.carrierEventRef.toString('hex'),
    delivered_at: c.deliveredAt.toString(),
    batch_id: c.batchId.toString(),
    index: c.index,
    proof: c.proof.map((p) => p.toString('hex')),
  };
}

export function claimFromFile(f: ClaimFile): AnchoredClaim {
  if (f.format !== 'motored-delivery-claim/v1') throw new Error(`unknown claim format ${String(f.format)}`);
  if (!Number.isInteger(f.index) || f.index < 0 || f.index > 0xffffffff) throw new Error('index must be a u32');
  return {
    escrow: f.escrow,
    orderRef: hex32('order_ref', f.order_ref),
    parcelsCommit: hex32('parcels_commit', f.parcels_commit),
    carrierEventRef: hex32('carrier_event_ref', f.carrier_event_ref),
    deliveredAt: BigInt(f.delivered_at),
    batchId: BigInt(f.batch_id),
    index: f.index,
    proof: f.proof.map((p, i) => hex32(`proof[${i}]`, p)),
  };
}
