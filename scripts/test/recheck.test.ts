import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { StrKey } from '@stellar/stellar-sdk';
import { buildTree, claimLeaf, claimToFile, proofOf, rootOf, type AnchoredClaim } from '../lib/claims.js';
import { InMemoryGuard, InMemoryRegistry, recheckClaim } from '../claims/recheck-core.js';
import { main as recheckMain } from '../claims/recheck.js';

const ESCROW = StrKey.encodeContract(Buffer.alloc(32, 0x0e));
const REGISTRY = StrKey.encodeContract(Buffer.alloc(32, 0x0f));

/** A claims test vector: one real claim among padding in an 8-leaf batch. */
function vector(): { claim: AnchoredClaim; root: Buffer } {
  const base = { orderRef: Buffer.alloc(32, 0xa1), parcelsCommit: Buffer.alloc(32, 0xa2), carrierEventRef: Buffer.alloc(32, 0xa3), deliveredAt: 1_800_000_100n };
  const others = [1, 2].map((i) => claimLeaf(StrKey.encodeContract(Buffer.alloc(32, i)), base));
  const leaves = [...others, claimLeaf(ESCROW, base)];
  const levels = buildTree(leaves, 8);
  return { claim: { ...base, escrow: ESCROW, batchId: 42n, index: 2, proof: proofOf(levels, 2) }, root: rootOf(levels) };
}

describe('recheckClaim', () => {
  it('passes for an anchored claim anchored after funding', async () => {
    const { claim, root } = vector();
    const reg = new InMemoryRegistry();
    reg.anchor(42n, root, 1_800_000_200n);
    const r = await recheckClaim(claim, reg, new InMemoryGuard(new Map([[ESCROW, 1_800_000_000n]])));
    expect(r.ok).toBe(true);
    expect(r.computedRoot).toBe(root.toString('hex'));
    expect(r.anchoredAfterFunding).toBe(true);
  });

  it('fails once the batch is revoked', async () => {
    const { claim, root } = vector();
    const reg = new InMemoryRegistry();
    reg.anchor(42n, root, 1_800_000_200n);
    reg.revoke(42n);
    const r = await recheckClaim(claim, reg);
    expect(r.ok).toBe(false);
    expect(r.registryVerify).toBe(false);
    expect(r.anchorError).toBe('Revoked');
  });

  it('fails for a claim anchored before the escrow was funded', async () => {
    const { claim, root } = vector();
    const reg = new InMemoryRegistry();
    reg.anchor(42n, root, 1_799_999_999n);
    const r = await recheckClaim(claim, reg, new InMemoryGuard(new Map([[ESCROW, 1_800_000_000n]])));
    expect(r.ok).toBe(false);
    expect(r.anchoredAfterFunding).toBe(false);
  });

  it('fails for a tampered field', async () => {
    const { claim, root } = vector();
    const reg = new InMemoryRegistry();
    reg.anchor(42n, root, 1_800_000_200n);
    const r = await recheckClaim({ ...claim, deliveredAt: claim.deliveredAt + 1n }, reg);
    expect(r.ok).toBe(false);
  });
});

describe('recheck CLI (offline vector)', () => {
  it('verifies the vector against its published root and rejects a wrong root', async () => {
    const { claim, root } = vector();
    const dir = mkdtempSync(join(tmpdir(), 'ms-claim-'));
    const file = join(dir, 'claim.json');
    writeFileSync(file, JSON.stringify(claimToFile(claim, 'testnet', REGISTRY)));
    const lines: string[] = [];
    expect(await recheckMain(['--claim', file, '--root', root.toString('hex')], { log: (l) => lines.push(l) })).toBe(0);
    expect(JSON.parse(lines[0]!).ok).toBe(true);
    expect(await recheckMain(['--claim', file, '--root', Buffer.alloc(32).toString('hex')], { log: () => undefined })).toBe(2);
  });
});
