/**
 * In-memory implementations of every port. Used by the tests and the example
 * order flow; also a reference for what a real adapter must return.
 */
import type {
  Alert,
  ChainReader,
  Clock,
  EscrowChainState,
  EurcBalance,
  EurcTransfer,
  EventCoverage,
  ExpectedEscrow,
  LedgerSource,
  ReportSink,
  TrustlineState,
  TxStatus,
} from "./ports.js";
import type { DailyReport } from "./report.js";
import type { Units } from "./units.js";

/** A clock you move by hand. */
export class ManualClock implements Clock {
  constructor(private t: number) {}
  now(): number {
    return this.t;
  }
  set(t: number): void {
    this.t = t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

/** The expected ledger, held in a map. */
export class InMemoryLedgerSource implements LedgerSource {
  readonly escrows = new Map<string, ExpectedEscrow>();
  /** Set to make the next `listEscrows` throw (simulates a ledger outage). */
  failWith?: Error;

  put(e: ExpectedEscrow): this {
    this.escrows.set(e.escrowId, e);
    return this;
  }

  async listEscrows(_asOf: number): Promise<ExpectedEscrow[]> {
    if (this.failWith) throw this.failWith;
    return [...this.escrows.values()];
  }
}

/**
 * A tiny simulated chain: escrows, EURC balances derived from transfers,
 * transaction outcomes, trustlines and event coverage.
 *
 * Balances are computed from the recorded transfers unless overridden with
 * `setBalance` (used to simulate a missing event). Every helper returns `this`
 * so tests read as a short script.
 */
export class InMemoryChainReader implements ChainReader {
  readonly escrows = new Map<string, EscrowChainState>();
  readonly transfers: EurcTransfer[] = [];
  readonly txStatus = new Map<string, TxStatus>();
  readonly trustlines = new Map<string, TrustlineState>();
  readonly frozen = new Set<string>();
  readonly balanceOverride = new Map<string, Units>();
  coverage: EventCoverage = { oldestLedger: 1, latestLedger: 1, gaps: [] };
  private nextLedger = 1;

  putEscrow(id: string, state: EscrowChainState): this {
    this.escrows.set(id, state);
    return this;
  }

  /** Record a successful transfer and mark its tx successful. */
  transfer(t: Omit<EurcTransfer, "ledger"> & { ledger?: number }): this {
    const ledger = t.ledger ?? this.nextLedger++;
    this.transfers.push({ ...t, ledger });
    this.txStatus.set(t.txHash, "success");
    this.coverage.latestLedger = Math.max(this.coverage.latestLedger, ledger);
    return this;
  }

  setTx(txHash: string, status: TxStatus): this {
    this.txStatus.set(txHash, status);
    return this;
  }

  setTrustline(account: string, state: TrustlineState): this {
    this.trustlines.set(account, state);
    return this;
  }

  freeze(holder: string): this {
    this.frozen.add(holder);
    return this;
  }

  setBalance(holder: string, amount: Units): this {
    this.balanceOverride.set(holder, amount);
    return this;
  }

  setFlags(id: string, flags: Partial<EscrowChainState["flags"]>): this {
    const s = this.escrows.get(id);
    if (!s) throw new Error(`unknown escrow ${id}`);
    s.flags = { ...s.flags, ...flags };
    return this;
  }

  async getEscrowState(escrowId: string): Promise<EscrowChainState | null> {
    const s = this.escrows.get(escrowId);
    return s ? structuredClone(s) : null;
  }

  async getBalance(holder: string): Promise<EurcBalance> {
    const override = this.balanceOverride.get(holder);
    let amount = 0n;
    if (override !== undefined) amount = override;
    else
      for (const t of this.transfers) {
        if (t.to === holder) amount += t.amount;
        if (t.from === holder) amount -= t.amount;
      }
    return { amount, authorized: !this.frozen.has(holder) };
  }

  async getTransfers(holder: string): Promise<EurcTransfer[]> {
    return this.transfers.filter((t) => t.from === holder || t.to === holder).map((t) => ({ ...t }));
  }

  async getTxStatus(txHash: string): Promise<TxStatus> {
    return this.txStatus.get(txHash) ?? "not_found";
  }

  async getTrustline(account: string): Promise<TrustlineState> {
    return this.trustlines.get(account) ?? { exists: true, authorized: true };
  }

  async getEventCoverage(): Promise<EventCoverage> {
    return structuredClone(this.coverage);
  }
}

/** Collects reports and alerts in arrays. */
export class InMemoryReportSink implements ReportSink {
  readonly reports: DailyReport[] = [];
  readonly alerts: Alert[] = [];
  async writeDaily(report: DailyReport): Promise<void> {
    this.reports.push(report);
  }
  async alert(alert: Alert): Promise<void> {
    this.alerts.push(alert);
  }
}
