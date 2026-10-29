// In-memory implementations of every port in ./ports.ts. Used by tests and the
// example order flow; not for production (nothing is persisted).
import { sha256, toHex, utf8 } from "./bytes.js";
import { MAX_DEPTH, verifyProof } from "./merkle.js";
import { newParcelSalt } from "./leaf.js";
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
  type WriteReceipt,
} from "./ports.js";

/** A clock the test moves by hand. */
export class ManualClock implements Clock {
  constructor(private now: number = 1_761_337_000) {}
  nowSeconds(): number {
    return this.now;
  }
  set(t: number): void {
    this.now = t;
  }
  advance(seconds: number): void {
    this.now += seconds;
  }
}

export class InMemorySaltStore implements SaltStore {
  private readonly salts = new Map<string, Uint8Array>();
  async getOrCreate(orderRef: Uint8Array): Promise<Uint8Array> {
    const k = toHex(orderRef);
    let s = this.salts.get(k);
    if (!s) {
      s = newParcelSalt();
      this.salts.set(k, s);
    }
    return s;
  }
  async get(orderRef: Uint8Array): Promise<Uint8Array | undefined> {
    return this.salts.get(toHex(orderRef));
  }
}

/** A delivery oracle fed by `push`; the cursor is the index of the next event. */
export class InMemoryDeliveryOracle implements DeliveryOracle {
  private readonly events: DeliveredEvent[] = [];
  push(...e: DeliveredEvent[]): void {
    this.events.push(...e);
  }
  async poll(cursor?: string): Promise<{ events: DeliveredEvent[]; cursor?: string }> {
    const from = cursor ? Number(cursor) : 0;
    return { events: this.events.slice(from), cursor: String(this.events.length) };
  }
}

/**
 * Mirror of contracts/claim-registry: write-once roots stamped with the clock's
 * time, permanent revocation, `verify` that returns false for revoked or missing
 * batches and throws ProofTooLong beyond depth 32. Authorisation (issuer and revoker
 * `require_auth`) is not modelled; the contract tests cover it.
 */
export class InMemoryRegistry implements RegistryClient {
  private readonly roots = new Map<bigint, { root: Uint8Array; at: bigint }>();
  private readonly revoked = new Set<bigint>();
  private seq = 0;
  constructor(private readonly clock: Clock) {}

  private receipt(op: string, batchId: bigint): WriteReceipt {
    return { txHash: toHex(sha256(utf8(`in-memory/${op}/${batchId}/${this.seq++}`))) };
  }

  async anchor(batchId: bigint, root: Uint8Array): Promise<WriteReceipt> {
    if (root.length !== 32) throw new TypeError("root must be 32 bytes");
    if (this.roots.has(batchId)) throw new RegistryError(RegistryErrorCode.RootExists);
    this.roots.set(batchId, { root: new Uint8Array(root), at: BigInt(this.clock.nowSeconds()) });
    return this.receipt("anchor", batchId);
  }

  async revoke(batchId: bigint): Promise<WriteReceipt> {
    this.revoked.add(batchId);
    return this.receipt("revoke", batchId);
  }

  async anchoredAt(batchId: bigint): Promise<bigint> {
    if (this.revoked.has(batchId)) throw new RegistryError(RegistryErrorCode.Revoked);
    const r = this.roots.get(batchId);
    if (!r) throw new RegistryError(RegistryErrorCode.NoRoot);
    return r.at;
  }

  async verify(batchId: bigint, leaf: Uint8Array, proof: Uint8Array[], index: number): Promise<boolean> {
    if (proof.length > MAX_DEPTH) throw new RegistryError(RegistryErrorCode.ProofTooLong);
    if (this.revoked.has(batchId)) return false;
    const r = this.roots.get(batchId);
    if (!r) return false;
    return verifyProof(leaf, proof, index, r.root);
  }

  /** Test helper: the stored root, if any. */
  rootOf(batchId: bigint): Uint8Array | undefined {
    return this.roots.get(batchId)?.root;
  }
}

export class InMemoryClaimStore implements ClaimStore {
  private readonly pend = new Map<string, PendingClaim>();
  private readonly done = new Map<string, AnchoredClaim>();
  private last: bigint | undefined;
  private cur: string | undefined;

  async addPending(c: PendingClaim): Promise<boolean> {
    if (this.pend.has(c.escrow) || this.done.has(c.escrow)) return false;
    this.pend.set(c.escrow, c);
    return true;
  }
  async pending(): Promise<PendingClaim[]> {
    return [...this.pend.values()];
  }
  async markAnchored(claims: AnchoredClaim[]): Promise<void> {
    for (const c of claims) {
      this.pend.delete(c.escrow);
      this.done.set(c.escrow, c);
      if (this.last === undefined || c.batchId > this.last) this.last = c.batchId;
    }
  }
  async anchoredFor(escrow: string): Promise<AnchoredClaim | undefined> {
    return this.done.get(escrow);
  }
  async lastBatchId(): Promise<bigint | undefined> {
    return this.last;
  }
  async cursor(): Promise<string | undefined> {
    return this.cur;
  }
  async setCursor(cursor: string | undefined): Promise<void> {
    this.cur = cursor;
  }
}
