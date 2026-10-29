// Public re-check of a released order's claim: rebuilds the leaf from the published
// format, checks the proof locally, then asks the registry (read-only) whether the
// batch verifies and when it was anchored. Proves Merkle inclusion and anchor time,
// nothing more. Used by scripts/claims/recheck.ts.
import { equalBytes, toHex } from "./bytes.js";
import { type CarrierEvent, type Claim, carrierEventRef, claimLeaf, parcelsCommit } from "./leaf.js";
import { MAX_DEPTH } from "./merkle.js";
import { type RegistryClient, RegistryError } from "./ports.js";

/** Optional private disclosure: lets a party holding salt and carrier data check the commitments too. */
export interface Disclosure {
  salt?: Uint8Array;
  parcelNumber?: string;
  carrierEvent?: CarrierEvent;
}

export interface RecheckResult {
  ok: boolean;
  leaf: string;
  /** Registry `verify` result (false if revoked or missing). */
  onChainVerify: boolean;
  /** Anchor ledger time (unix seconds), if the batch is anchored and not revoked. */
  anchoredAt?: bigint;
  /** Registry error name if `anchored_at` failed (NoRoot, Revoked). */
  anchorError?: string;
  /** Present only when a disclosure was given. */
  parcelsCommitMatches?: boolean;
  carrierEventRefMatches?: boolean;
  problems: string[];
}

export async function recheckClaim(
  registry: RegistryClient,
  escrow: string,
  claim: Claim,
  disclosure: Disclosure = {},
): Promise<RecheckResult> {
  const problems: string[] = [];
  const leaf = claimLeaf(escrow, claim);
  if (claim.proof.length > MAX_DEPTH) problems.push(`proof longer than ${MAX_DEPTH}`);

  let onChainVerify = false;
  if (problems.length === 0) {
    onChainVerify = await registry.verify(claim.batchId, leaf, claim.proof, claim.index);
    if (!onChainVerify) problems.push("registry.verify returned false (wrong proof, missing or revoked batch)");
  }

  let anchoredAt: bigint | undefined;
  let anchorError: string | undefined;
  try {
    anchoredAt = await registry.anchoredAt(claim.batchId);
  } catch (e) {
    if (!(e instanceof RegistryError)) throw e;
    anchorError = e.message;
    problems.push(`anchored_at failed: ${e.message}`);
  }

  const res: RecheckResult = { ok: false, leaf: toHex(leaf), onChainVerify, problems };
  if (anchoredAt !== undefined) res.anchoredAt = anchoredAt;
  if (anchorError !== undefined) res.anchorError = anchorError;

  if (disclosure.salt && disclosure.parcelNumber !== undefined) {
    res.parcelsCommitMatches = equalBytes(parcelsCommit(disclosure.salt, disclosure.parcelNumber), claim.parcelsCommit);
    if (!res.parcelsCommitMatches) problems.push("parcels_commit does not match the disclosed salt and parcel number");
  }
  if (disclosure.carrierEvent) {
    res.carrierEventRefMatches = equalBytes(carrierEventRef(disclosure.carrierEvent), claim.carrierEventRef);
    if (!res.carrierEventRefMatches) problems.push("carrier_event_ref does not match the disclosed carrier event");
  }
  res.ok = problems.length === 0;
  return res;
}
