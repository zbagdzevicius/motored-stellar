// The claim anchoring job (pre-award; used by SCF D6): turns delivered events into claims, batches them
// into a Merkle tree and anchors the root through the registry. Run `ingest` as
// events arrive (or on a short poll) and `anchorBatch` hourly.
import { equalBytes, toU64 } from "./bytes.js";
import { carrierEventRef, claimLeaf, parcelsCommit } from "./leaf.js";
import { buildTree, proofOf } from "./merkle.js";
import {
  type AnchoredClaim,
  type ClaimStore,
  type Clock,
  type DeliveredEvent,
  type DeliveryOracle,
  type PendingClaim,
  type RegistryClient,
  RegistryError,
  RegistryErrorCode,
  type SaltStore,
} from "./ports.js";

export const HOUR = 3600;

export interface AnchoringJobDeps {
  oracle: DeliveryOracle;
  salts: SaltStore;
  registry: RegistryClient;
  store: ClaimStore;
  clock: Clock;
  /** Seconds per batch window. Default one hour. */
  batchWindow?: number;
  /** Upper bound on claims per batch. Default 2^16 (depth 16). */
  maxBatch?: number;
}

export interface BatchResult {
  batchId: bigint;
  root: Uint8Array;
  depth: number;
  claims: AnchoredClaim[];
  anchorTx: string;
}

/** Builds the pending claim for one delivered event. */
export async function claimFromEvent(e: DeliveredEvent, salts: SaltStore): Promise<PendingClaim> {
  if (e.orderRef.length !== 32) throw new TypeError("orderRef must be 32 bytes");
  const salt = await salts.getOrCreate(e.orderRef);
  const fields = {
    orderRef: e.orderRef,
    parcelsCommit: parcelsCommit(salt, e.parcelNumber),
    carrierEventRef: carrierEventRef({
      parcelNumber: e.parcelNumber,
      statusText: e.carrierStatusText,
      dateTime: e.carrierDateTime,
      lang: e.lang ?? "en",
    }),
    deliveredAt: toU64(e.deliveredAt),
  };
  return { escrow: e.escrow, ...fields, leaf: claimLeaf(e.escrow, fields) };
}

export class ClaimAnchoringJob {
  private readonly window: number;
  private readonly maxBatch: number;

  constructor(private readonly d: AnchoringJobDeps) {
    this.window = d.batchWindow ?? HOUR;
    this.maxBatch = d.maxBatch ?? 1 << 16;
    if (!Number.isInteger(this.window) || this.window <= 0) throw new RangeError("batchWindow must be a positive integer");
  }

  /** Pulls new delivered events and queues one claim per escrow. Returns how many were queued. */
  async ingest(): Promise<number> {
    const { events, cursor } = await this.d.oracle.poll(await this.d.store.cursor());
    let added = 0;
    for (const e of events) {
      if (await this.d.store.addPending(await claimFromEvent(e, this.d.salts))) added++;
    }
    await this.d.store.setCursor(cursor);
    return added;
  }

  /**
   * Batch ids are the batch window index (unix time / window), moved forward past
   * the last id this job used, so ids are strictly increasing and never collide with
   * an earlier anchor even when the job runs twice in one window.
   */
  async nextBatchId(): Promise<bigint> {
    const byClock = BigInt(Math.floor(this.d.clock.nowSeconds() / this.window));
    const last = await this.d.store.lastBatchId();
    return last !== undefined && last >= byClock ? last + 1n : byClock;
  }

  /**
   * Anchors the pending claims as one batch. Returns undefined when nothing is
   * pending. If the registry already holds this batch id with the same root (a
   * retried run whose first anchor landed), the existing anchor is accepted.
   */
  async anchorBatch(): Promise<BatchResult | undefined> {
    const pending = (await this.d.store.pending()).slice(0, this.maxBatch);
    if (pending.length === 0) return undefined;
    const tree = buildTree(
      pending.map((c) => c.leaf),
      this.maxBatch,
    );
    const batchId = await this.nextBatchId();
    let anchorTx: string;
    try {
      anchorTx = (await this.d.registry.anchor(batchId, tree.root)).txHash;
    } catch (err) {
      if (!(err instanceof RegistryError && err.code === RegistryErrorCode.RootExists)) throw err;
      // Same id already anchored: accept it only if it is this exact root.
      const ok = await this.d.registry.verify(batchId, pending[0]!.leaf, proofOf(tree, 0), 0);
      if (!ok) throw err;
      anchorTx = "existing";
    }
    const claims: AnchoredClaim[] = pending.map((c, index) => ({
      ...c,
      batchId,
      index,
      proof: proofOf(tree, index),
      root: tree.root,
      anchorTx,
    }));
    await this.d.store.markAnchored(claims);
    return { batchId, root: tree.root, depth: tree.depth, claims, anchorTx };
  }

  /** Looks up the anchored claim for an escrow and checks it against the registry. */
  async claimFor(escrow: string): Promise<AnchoredClaim | undefined> {
    const c = await this.d.store.anchoredFor(escrow);
    if (!c) return undefined;
    if (!equalBytes(c.leaf, claimLeaf(escrow, c))) throw new Error("stored claim does not match its leaf");
    return c;
  }
}
