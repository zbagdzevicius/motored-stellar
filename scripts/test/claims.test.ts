import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { StrKey, xdr } from '@stellar/stellar-sdk';
import {
  addressXdr,
  buildTree,
  claimFromFile,
  claimLeaf,
  claimToFile,
  claimToScVal,
  padLeaf,
  parcelsCommitment,
  proofOf,
  rootOf,
  verifyProof,
  walkProof,
  type DeliveryClaim,
} from '../lib/claims.js';

const sha = (b: Buffer) => createHash('sha256').update(b).digest();
const ESCROW_RAW = Buffer.alloc(32, 0xe5);
const ESCROW = StrKey.encodeContract(ESCROW_RAW);
const claim: DeliveryClaim = {
  orderRef: Buffer.alloc(32, 0x11),
  parcelsCommit: Buffer.alloc(32, 0x22),
  carrierEventRef: Buffer.alloc(32, 0x33),
  deliveredAt: 1_800_000_000n,
};

describe('delivery-claim leaf', () => {
  it('encodes the escrow as XDR ScVal::Address (independent byte layout)', () => {
    // SCV_ADDRESS = 18, SC_ADDRESS_TYPE_CONTRACT = 1, then the 32-byte contract hash.
    const expected = Buffer.concat([Buffer.from([0, 0, 0, 18, 0, 0, 0, 1]), ESCROW_RAW]);
    expect(addressXdr(ESCROW).equals(expected)).toBe(true);
  });

  it('matches the published formula byte for byte', () => {
    const be = Buffer.alloc(8);
    be.writeBigUInt64BE(claim.deliveredAt);
    const manual = sha(Buffer.concat([Buffer.from([0x01, 0, 0, 0, 18, 0, 0, 0, 1]), ESCROW_RAW, claim.orderRef, claim.parcelsCommit, claim.carrierEventRef, be]));
    expect(claimLeaf(ESCROW, claim).equals(manual)).toBe(true);
  });

  it('binds the leaf to the escrow', () => {
    const other = StrKey.encodeContract(Buffer.alloc(32, 0xe6));
    expect(claimLeaf(ESCROW, claim).equals(claimLeaf(other, claim))).toBe(false);
  });

  it('rejects wrong field lengths', () => {
    expect(() => claimLeaf(ESCROW, { ...claim, orderRef: Buffer.alloc(31) })).toThrow(/32 bytes/);
  });

  it('commits to the parcel number with a keyed HMAC', () => {
    const salt = Buffer.alloc(32, 9);
    expect(parcelsCommitment(salt, 'P1').equals(parcelsCommitment(salt, 'P1'))).toBe(true);
    expect(parcelsCommitment(salt, 'P1').equals(parcelsCommitment(Buffer.alloc(32, 8), 'P1'))).toBe(false);
    expect(() => parcelsCommitment(Buffer.alloc(16), 'P1')).toThrow();
  });
});

describe('batch tree', () => {
  const leaves = [0, 1, 2, 3, 4].map((i) => sha(Buffer.from([i])));
  const levels = buildTree(leaves, 8);
  const root = rootOf(levels);

  it('pads with tagged padding leaves to the batch size', () => {
    expect(levels[0]).toHaveLength(8);
    expect((levels[0] as Buffer[])[7]!.equals(padLeaf(7))).toBe(true);
  });

  it('proves every leaf and nothing else', () => {
    leaves.forEach((leaf, i) => {
      const proof = proofOf(levels, i);
      expect(proof).toHaveLength(3);
      expect(verifyProof(leaf, proof, i, root)).toBe(true);
      expect(verifyProof(leaf, proof, i ^ 1, root)).toBe(false);
    });
  });

  it('rejects index aliasing (bits left over)', () => {
    const proof = proofOf(levels, 2);
    expect(walkProof(leaves[2]!, proof, 2 + 8)).toBeNull();
    expect(verifyProof(leaves[2]!, proof, 2 + 8, root)).toBe(false);
  });

  it('rejects proofs deeper than 32', () => {
    expect(walkProof(leaves[0]!, Array.from({ length: 33 }, () => leaves[0]!), 0)).toBeNull();
  });
});

describe('claim encodings', () => {
  const anchored = { ...claim, escrow: ESCROW, batchId: 1_761_337_000_000n, index: 5, proof: [Buffer.alloc(32, 1), Buffer.alloc(32, 2)] };

  it('round-trips through the public JSON form', () => {
    const f = claimToFile(anchored, 'testnet', StrKey.encodeContract(Buffer.alloc(32, 0xaa)));
    expect(f.format).toBe('motored-delivery-claim/v1');
    expect(claimFromFile(f)).toEqual(anchored);
    expect(() => claimFromFile({ ...f, order_ref: 'zz' })).toThrow();
  });

  it("builds the guard's Claim struct with sorted field names", () => {
    const v = claimToScVal(anchored);
    const keys = (xdr.expectUnionVariant(v, 'scvMap').map ?? []).map((e) => xdr.expectUnionVariant(e.key, 'scvSymbol').sym.toString());
    expect(keys).toEqual(['batch_id', 'carrier_event_ref', 'delivered_at', 'index', 'order_ref', 'parcels_commit', 'proof']);
  });
});
