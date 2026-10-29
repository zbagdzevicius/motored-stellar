// Merkle batches of claim leaves, matching the claim registry's `verify`:
//
//   node = sha256(0x02 || left || right)
//   for each sibling: if index & 1 { h = node(sib, h) } else { h = node(h, sib) }; index >>= 1
//   valid iff proof.len() <= 32 AND index == 0 at the end AND h == root
//
// The registry has no rule for odd nodes; it only walks the proof. So a batch is
// padded to the next power of two with deterministic padding leaves
// sha256(0x03 || u32_be(i)). Every real leaf
// then has a full-depth proof the registry accepts unchanged. Padding leaves hide
// nothing but the batch size and can never be presented as a claim: the guard builds
// the leaf itself from claim fields under the 0x01 tag.
import { concat, equalBytes, sha256, u32be } from "./bytes.js";

export const TAG_NODE = 0x02;
export const TAG_PAD = 0x03;
/** Maximum proof length the registry accepts (`MAX_DEPTH`). */
export const MAX_DEPTH = 32;

export const nodeHash = (l: Uint8Array, r: Uint8Array): Uint8Array => sha256(concat(Uint8Array.of(TAG_NODE), l, r));

/** Padding leaf for position `i`. */
export const padLeaf = (i: number): Uint8Array => sha256(concat(Uint8Array.of(TAG_PAD), u32be(i)));

/** A built batch: every level, bottom (padded leaves) first, root last. */
export interface MerkleTree {
  /** Number of real (unpadded) leaves. */
  size: number;
  depth: number;
  levels: Uint8Array[][];
  root: Uint8Array;
}

/**
 * Builds a padded tree. `maxLeaves` caps memory; it defaults to 2^20 and may not
 * exceed 2^32 (depth 32).
 */
export function buildTree(leaves: Uint8Array[], maxLeaves = 1 << 20): MerkleTree {
  if (leaves.length === 0) throw new Error("empty batch");
  if (maxLeaves > 2 ** MAX_DEPTH) throw new RangeError("maxLeaves exceeds 2^32");
  if (leaves.length > maxLeaves) throw new RangeError(`batch of ${leaves.length} exceeds maxLeaves ${maxLeaves}`);
  for (const l of leaves) if (l.length !== 32) throw new TypeError("leaves must be 32 bytes");
  let width = 1;
  while (width < leaves.length) width *= 2;
  const level0 = [...leaves];
  for (let i = leaves.length; i < width; i++) level0.push(padLeaf(i));
  const levels: Uint8Array[][] = [level0];
  for (let cur = level0; cur.length > 1; ) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < cur.length; i += 2) next.push(nodeHash(cur[i]!, cur[i + 1]!));
    levels.push(next);
    cur = next;
  }
  return { size: leaves.length, depth: levels.length - 1, levels, root: levels[levels.length - 1]![0]! };
}

/** Proof for the real leaf at `index`: siblings bottom-up, as the registry expects. */
export function proofOf(tree: MerkleTree, index: number): Uint8Array[] {
  if (!Number.isInteger(index) || index < 0 || index >= tree.size) throw new RangeError(`index ${index} out of range`);
  const proof: Uint8Array[] = [];
  let i = index;
  for (let d = 0; d < tree.depth; d++) {
    proof.push(tree.levels[d]![i ^ 1]!);
    i >>= 1;
  }
  return proof;
}

/**
 * Local mirror of the registry's `verify` (without the revocation and stored-root
 * lookups). Returns false where the contract returns false; a proof longer than
 * {@link MAX_DEPTH} returns false here, where the contract returns Error ProofTooLong.
 */
export function verifyProof(leaf: Uint8Array, proof: Uint8Array[], index: number, root: Uint8Array): boolean {
  if (proof.length > MAX_DEPTH) return false;
  if (!Number.isInteger(index) || index < 0 || index > 0xffff_ffff) return false;
  // The contract walks the index as a u64 and requires it to be fully consumed.
  let i = BigInt(index);
  let h = leaf;
  for (const sib of proof) {
    h = i & 1n ? nodeHash(sib, h) : nodeHash(h, sib);
    i >>= 1n;
  }
  return i === 0n && equalBytes(h, root);
}
