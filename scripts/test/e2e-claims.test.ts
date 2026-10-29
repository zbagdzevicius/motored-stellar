import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { StrKey } from '@stellar/stellar-sdk';
import { MAX_DEPTH, buildTree, claimLeaf, deepenProof, proofOf, rootOf, verifyProof, walkProof, type DeliveryClaim } from '../lib/claims.js';
import { InMemoryRegistry, recheckClaim } from '../claims/recheck-core.js';
import { SILENT_BUYER_PROOF_DEPTH, refusedWith, secondsToWait } from '../testnet/e2e-claims.js';
import { CLAIM_BATCH_SIZE } from '../testnet/order-kit.js';

const ESCROW = StrKey.encodeContract(Buffer.alloc(32, 0xd1));
const claim: DeliveryClaim = { orderRef: Buffer.alloc(32, 1), parcelsCommit: Buffer.alloc(32, 2), carrierEventRef: Buffer.alloc(32, 3), deliveredAt: 1_800_000_000n };

describe('depth-32 silent-buyer proof', () => {
  const leaf = claimLeaf(ESCROW, claim);
  const levels = buildTree([leaf], CLAIM_BATCH_SIZE);

  it('extends the batch proof to the registry maximum and still verifies', () => {
    expect(SILENT_BUYER_PROOF_DEPTH).toBe(MAX_DEPTH);
    const { proof, root } = deepenProof(levels, 0, SILENT_BUYER_PROOF_DEPTH, () => randomBytes(32));
    expect(proof).toHaveLength(32);
    expect(proof.slice(0, 3)).toEqual(proofOf(levels, 0));
    expect(verifyProof(leaf, proof, 0, root)).toBe(true);
    expect(root.equals(rootOf(levels))).toBe(false);
  });

  it('keeps every other batch leaf provable under the same root', () => {
    const leaves = [0, 1, 2].map((i) => claimLeaf(ESCROW, { ...claim, orderRef: Buffer.alloc(32, 10 + i) }));
    const lv = buildTree(leaves, CLAIM_BATCH_SIZE);
    const fill = Array.from({ length: 32 }, () => randomBytes(32));
    const a = deepenProof(lv, 0, 32, (d) => fill[d]!);
    const b = deepenProof(lv, 2, 32, (d) => fill[d]!);
    expect(a.root.equals(b.root)).toBe(true);
    expect(verifyProof(leaves[2]!, b.proof, 2, a.root)).toBe(true);
  });

  it('rejects depths outside [batch depth, 32] and bad filler', () => {
    expect(() => deepenProof(levels, 0, 33, () => randomBytes(32))).toThrow();
    expect(() => deepenProof(levels, 0, 2, () => randomBytes(32))).toThrow();
    expect(() => deepenProof(levels, 0, 10, () => Buffer.alloc(31))).toThrow(/32 bytes/);
    const { proof } = deepenProof(levels, 0, 32, () => randomBytes(32));
    expect(walkProof(leaf, [...proof, randomBytes(32)], 0)).toBeNull();
  });

  it('passes the public re-check once anchored, and fails for a tampered field', async () => {
    const { proof, root } = deepenProof(levels, 0, 32, () => randomBytes(32));
    const reg = new InMemoryRegistry();
    reg.anchor(7n, root, 100n);
    const anchored = { ...claim, escrow: ESCROW, batchId: 7n, index: 0, proof };
    expect((await recheckClaim(anchored, reg)).ok).toBe(true);
    expect((await recheckClaim({ ...anchored, carrierEventRef: Buffer.alloc(32, 4) }, reg)).ok).toBe(false);
  });
});

describe('e2e-claims helpers', () => {
  it('waits until the latest deadline plus slack, never negative', () => {
    expect(secondsToWait([1000, 1100], 1000, 15)).toBe(115);
    expect(secondsToWait([900], 1000, 15)).toBe(0);
    expect(secondsToWait([], 1000)).toBe(0);
  });

  it('recognises a refusal by guard error code', () => {
    expect(refusedWith({ label: 'x', refused: 'Error(Contract, #25) Contested (if raised by the guard)' }, 25)).toBe(true);
    expect(refusedWith({ label: 'x', refused: 'Error(Contract, #250)' }, 25)).toBe(false);
    expect(refusedWith({ label: 'x', hash: 'h', status: 'SUCCESS', link: '' }, 25)).toBe(false);
  });
});
