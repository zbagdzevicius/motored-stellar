/**
 * Public re-check of a released order's delivery claim (pre-award; used by SCF deliverable D6).
 *
 * Given the published claim JSON, anyone can confirm that:
 *   1. the leaf recomputed from the claim's public fields and the escrow address
 *      walks up the proof to a root (no aliasing: every bit of `index` is used);
 *   2. the claim registry says `verify(batch_id, leaf, proof, index) == true`,
 *      which is false for a revoked batch;
 *   3. the batch's anchor time, and (optionally) that it is later than the
 *      guard's record of when the escrow was first seen fully funded, the rule
 *      the guard applies before a claim-based seller payout.
 * It proves Merkle inclusion and anchor time, nothing more: the claim carries no
 * parcel number and no salt.
 *
 * The registry and guard are reached through small reader ports so the logic
 * runs offline in tests (InMemoryRegistry) and against Soroban RPC in the CLI.
 */
import { claimLeaf, nodeHash, walkProof, type AnchoredClaim } from '../lib/claims.js';

/** Read side of contracts/claim-registry. */
export interface RegistryReader {
  verify(batchId: bigint, leaf: Buffer, proof: Buffer[], index: number): Promise<boolean>;
  /** Anchor ledger time, or an error string (`Revoked`, `NoRoot`, ...). */
  anchoredAt(batchId: bigint): Promise<bigint | { error: string }>;
}

/** Read side of the guard's per-escrow registration. */
export interface GuardReader {
  /** First time the guard saw the escrow fully funded, if registered and funded. */
  fundedAt(escrow: string): Promise<bigint | undefined>;
}

export interface RecheckResult {
  ok: boolean;
  leaf: string;
  /** Root recomputed locally from the proof, or null when `index` has bits left over. */
  computedRoot: string | null;
  registryVerify: boolean;
  anchoredAt?: string;
  anchorError?: string;
  fundedAt?: string;
  /** anchored_at > funded_at, when the guard was asked. */
  anchoredAfterFunding?: boolean;
  reasons: string[];
}

export async function recheckClaim(claim: AnchoredClaim, registry: RegistryReader, guard?: GuardReader): Promise<RecheckResult> {
  const reasons: string[] = [];
  const leaf = claimLeaf(claim.escrow, claim);
  const root = walkProof(leaf, claim.proof, claim.index);
  if (root === null) reasons.push('proof does not consume every bit of index (or is longer than 32)');

  const registryVerify = await registry.verify(claim.batchId, leaf, claim.proof, claim.index);
  if (!registryVerify) reasons.push('registry.verify returned false (wrong proof, unknown batch, or revoked batch)');

  const at = await registry.anchoredAt(claim.batchId);
  const result: RecheckResult = {
    ok: false,
    leaf: leaf.toString('hex'),
    computedRoot: root ? root.toString('hex') : null,
    registryVerify,
    reasons,
  };
  if (typeof at === 'bigint') result.anchoredAt = at.toString();
  else {
    result.anchorError = at.error;
    reasons.push(`registry.anchored_at failed: ${at.error}`);
  }

  if (guard) {
    const funded = await guard.fundedAt(claim.escrow);
    if (funded === undefined) reasons.push('guard has no funded_at for this escrow');
    else {
      result.fundedAt = funded.toString();
      if (typeof at === 'bigint') {
        result.anchoredAfterFunding = at > funded;
        if (!result.anchoredAfterFunding) reasons.push('claim was anchored before the escrow was seen fully funded');
      }
    }
  }
  result.ok = reasons.length === 0;
  return result;
}

/** In-memory registry with the contract's exact verify semantics. For tests and the mock example. */
export class InMemoryRegistry implements RegistryReader {
  private roots = new Map<bigint, { root: Buffer; at: bigint }>();
  private revoked = new Set<bigint>();

  anchor(batchId: bigint, root: Buffer, at: bigint): void {
    if (this.roots.has(batchId)) throw new Error('RootExists');
    this.roots.set(batchId, { root, at });
  }
  revoke(batchId: bigint): void {
    this.revoked.add(batchId);
  }
  async verify(batchId: bigint, leaf: Buffer, proof: Buffer[], index: number): Promise<boolean> {
    if (proof.length > 32) throw new Error('ProofTooLong');
    if (this.revoked.has(batchId)) return false;
    const rec = this.roots.get(batchId);
    if (!rec) return false;
    let h = leaf;
    let i = BigInt(index >>> 0);
    for (const sib of proof) {
      h = i & 1n ? nodeHash(sib, h) : nodeHash(h, sib);
      i >>= 1n;
    }
    return i === 0n && h.equals(rec.root);
  }
  async anchoredAt(batchId: bigint): Promise<bigint | { error: string }> {
    if (this.revoked.has(batchId)) return { error: 'Revoked' };
    const rec = this.roots.get(batchId);
    return rec ? rec.at : { error: 'NoRoot' };
  }
}

/** In-memory guard reader. */
export class InMemoryGuard implements GuardReader {
  constructor(private readonly funded: Map<string, bigint> = new Map()) {}
  async fundedAt(escrow: string): Promise<bigint | undefined> {
    return this.funded.get(escrow);
  }
}
