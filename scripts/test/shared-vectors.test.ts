/**
 * The scripts keep their own copy of the claim leaf and Merkle code (lib/claims.ts) so the CLIs
 * run standalone. This test pins that copy to the golden vectors in packages/claims, which the
 * Rust guard tests (contracts/guard/src/test_vectors.rs) assert too. All three must agree.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { addressXdr, buildTree, claimLeaf, padLeaf, parcelsCommitment, rootOf } from '../lib/claims.js';

interface LeafVector {
  name: string;
  escrow: string;
  escrow_scval_xdr: string;
  order_ref: string;
  parcel_number: string;
  salt: string;
  parcels_commit: string;
  carrier_event_ref: string;
  delivered_at: string;
  leaf: string;
}
interface Vectors {
  leaves: LeafVector[];
  merkle: { leaves: string[]; padding_leaf_3: string; root: string };
}

const vectors = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../packages/claims/test/vectors.json', import.meta.url)), 'utf8'),
) as Vectors;
const hex = (s: string): Buffer => Buffer.from(s, 'hex');

describe('scripts/lib/claims.ts matches the shared golden vectors', () => {
  for (const v of vectors.leaves) {
    it(v.name, () => {
      expect(addressXdr(v.escrow).toString('hex')).toBe(v.escrow_scval_xdr);
      expect(parcelsCommitment(hex(v.salt), v.parcel_number).toString('hex')).toBe(v.parcels_commit);
      const leaf = claimLeaf(v.escrow, {
        orderRef: hex(v.order_ref),
        parcelsCommit: hex(v.parcels_commit),
        carrierEventRef: hex(v.carrier_event_ref),
        deliveredAt: BigInt(v.delivered_at),
      });
      expect(leaf.toString('hex')).toBe(v.leaf);
    });
  }

  it('3-leaf Merkle root and padding leaf', () => {
    expect(padLeaf(3).toString('hex')).toBe(vectors.merkle.padding_leaf_3);
    const levels = buildTree(vectors.merkle.leaves.map(hex));
    expect(rootOf(levels).toString('hex')).toBe(vectors.merkle.root);
  });
});
