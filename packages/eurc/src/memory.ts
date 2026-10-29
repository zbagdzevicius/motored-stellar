/**
 * In-memory implementations of every port in `ports.ts`. Used by the tests and
 * by the order-flow example when it runs without a network.
 */
import type { FeeBumpTransaction, Transaction } from "@stellar/stellar-sdk";
import type {
  AccountReader,
  AccountSnapshot,
  BalanceLine,
  Clock,
  RampDestination,
  RateLimiter,
  SimulationOutcome,
  SubmitOutcome,
  Submitter,
  WalletRegistry,
} from "./ports.js";

/** A map of account snapshots. */
export class InMemoryAccountReader implements AccountReader {
  private readonly accounts = new Map<string, AccountSnapshot>();

  put(snapshot: AccountSnapshot): this {
    this.accounts.set(snapshot.accountId, snapshot);
    return this;
  }

  /** Convenience: an account with a sequence and some balance lines. */
  putAccount(accountId: string, balances: BalanceLine[] = [], sequence = "100"): this {
    return this.put({ accountId, sequence, balances });
  }

  delete(accountId: string): this {
    this.accounts.delete(accountId);
    return this;
  }

  async loadAccount(accountId: string): Promise<AccountSnapshot | null> {
    return this.accounts.get(accountId) ?? null;
  }
}

/**
 * Records submissions and returns scripted outcomes. By default every
 * simulation succeeds and every submission succeeds with the tx hash.
 */
export class InMemorySubmitter implements Submitter {
  readonly submitted: Array<Transaction | FeeBumpTransaction> = [];
  readonly simulated: Transaction[] = [];
  simulateResult: SimulationOutcome = { ok: true, minResourceFee: "100000" };
  submitError?: string;

  constructor(readonly networkPassphrase: string) {}

  async simulate(tx: Transaction): Promise<SimulationOutcome> {
    this.simulated.push(tx);
    return this.simulateResult;
  }

  async submit(tx: Transaction | FeeBumpTransaction): Promise<SubmitOutcome> {
    this.submitted.push(tx);
    const hash = Buffer.from(tx.hash()).toString("hex");
    return this.submitError ? { ok: false, hash, error: this.submitError } : { ok: true, hash };
  }
}

interface WalletEntry {
  escrows: Set<string>;
  ramp: RampDestination | null;
}

/** Registered wallets, their escrows and their ramp destinations. */
export class InMemoryWalletRegistry implements WalletRegistry {
  private readonly wallets = new Map<string, WalletEntry>();

  register(account: string, opts: { escrows?: string[]; ramp?: RampDestination | null } = {}): this {
    this.wallets.set(account, { escrows: new Set(opts.escrows ?? []), ramp: opts.ramp ?? null });
    return this;
  }

  addEscrow(account: string, escrowId: string): this {
    const w = this.wallets.get(account);
    if (!w) throw new Error(`wallet not registered: ${account}`);
    w.escrows.add(escrowId);
    return this;
  }

  async isRegistered(account: string): Promise<boolean> {
    return this.wallets.has(account);
  }

  async escrowsOf(account: string): Promise<readonly string[]> {
    return [...(this.wallets.get(account)?.escrows ?? [])];
  }

  async rampDestinationOf(account: string): Promise<RampDestination | null> {
    return this.wallets.get(account)?.ramp ?? null;
  }
}

/** Wall-clock time. */
export const systemClock: Clock = { now: () => Date.now() };

/** A clock that only moves when told to. */
export class ManualClock implements Clock {
  constructor(private t = 0) {}
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

/**
 * Fixed-window limiter: at most `limit` takes per key in each `windowMs`.
 * Good enough for one process; a multi-instance host would back this port
 * with its database.
 */
export class FixedWindowRateLimiter implements RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly clock: Clock = systemClock,
  ) {
    if (limit < 1 || windowMs <= 0) throw new RangeError("limit must be >= 1 and windowMs > 0");
  }

  async take(key: string): Promise<boolean> {
    const now = this.clock.now();
    const w = this.windows.get(key);
    if (!w || now - w.start >= this.windowMs) {
      this.windows.set(key, { start: now, count: 1 });
      return true;
    }
    if (w.count >= this.limit) return false;
    w.count += 1;
    return true;
  }
}

/** A limiter that never limits (tests that do not exercise rate limits). */
export const unlimited: RateLimiter = { take: async () => true };
