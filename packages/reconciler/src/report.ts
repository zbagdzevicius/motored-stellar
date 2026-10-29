/**
 * Daily aggregate report (SCF D12).
 *
 * Folds one UTC day of 15-minute runs into a single pass/fail report with
 * counts. The report carries no escrow IDs, order references, addresses or
 * per-order amounts: it is safe to publish.
 *
 * A day passes only when enough runs happened (a stalled scheduler must not
 * look like a clean day) and every run passed.
 */
import { FINDING_KINDS, type FindingKind } from "./findings.js";
import type { RunResult } from "./reconcile.js";

export const DAILY_REPORT_SCHEMA = "motored-stellar/reconciliation-daily@1";

export interface DailyReport {
  schema: typeof DAILY_REPORT_SCHEMA;
  /** UTC day, YYYY-MM-DD. */
  day: string;
  /** Network label supplied by the caller, e.g. "testnet". */
  network: string;
  pass: boolean;
  /** Sorted, distinct reasons; empty when `pass`. */
  failReasons: string[];
  runs: { expected: number; required: number; completed: number; failed: number };
  unexplained: {
    /** Distinct (escrow, kind) differences with unexplained money during the day. */
    differences: number;
    /** Highest unexplained cents in any single run, as a decimal string. */
    centsMax: string;
    /** Unexplained cents in the day's last run, as a decimal string. */
    centsLatest: string;
  };
  /**
   * For each finding kind: how many distinct escrows showed it during the day
   * (global findings such as a fee-account trustline count once).
   */
  findings: Record<FindingKind, number>;
}

export interface DailyReportOptions {
  day: string;
  network: string;
  /** Runs expected per day. Default 96 (every 15 minutes). */
  expectedRuns?: number;
  /** Share of expected runs that must have completed. Default 0.95. */
  minRunShare?: number;
}

/** Build the daily report from the day's runs. Runs outside the UTC day are ignored. */
export function buildDailyReport(runs: readonly RunResult[], opts: DailyReportOptions): DailyReport {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.day)) throw new Error(`day must be YYYY-MM-DD: ${opts.day}`);
  const dayStart = Date.parse(`${opts.day}T00:00:00.000Z`);
  const dayEnd = dayStart + 24 * 60 * 60 * 1000;
  const inDay = runs.filter((r) => r.startedAt >= dayStart && r.startedAt < dayEnd).sort((a, b) => a.startedAt - b.startedAt);

  const expected = opts.expectedRuns ?? 96;
  const required = Math.ceil(expected * (opts.minRunShare ?? 0.95));

  const seen = new Map<FindingKind, Set<string>>();
  const unexplainedKeys = new Set<string>();
  const reasons = new Set<string>();
  let centsMax = 0n;
  for (const run of inDay) {
    if (!run.pass) for (const r of run.failReasons) reasons.add(r);
    if (run.unexplainedCents > centsMax) centsMax = run.unexplainedCents;
    for (const f of run.findings) {
      const key = f.escrowId ?? "*";
      let set = seen.get(f.kind);
      if (!set) seen.set(f.kind, (set = new Set()));
      set.add(key);
      if (f.unexplainedUnits > 0n) unexplainedKeys.add(`${f.kind}|${key}`);
    }
  }
  if (inDay.length < required) reasons.add("missed_runs");

  const findings = Object.fromEntries(
    (Object.keys(FINDING_KINDS) as FindingKind[]).map((k) => [k, seen.get(k)?.size ?? 0]),
  ) as Record<FindingKind, number>;

  const failReasons = [...reasons].sort();
  return {
    schema: DAILY_REPORT_SCHEMA,
    day: opts.day,
    network: opts.network,
    pass: failReasons.length === 0,
    failReasons,
    runs: { expected, required, completed: inDay.length, failed: inDay.filter((r) => !r.pass).length },
    unexplained: {
      differences: unexplainedKeys.size,
      centsMax: centsMax.toString(),
      centsLatest: (inDay.at(-1)?.unexplainedCents ?? 0n).toString(),
    },
    findings,
  };
}

/** Render the report as short Markdown for publishing. */
export function renderDailyMarkdown(r: DailyReport): string {
  const lines = [
    `# Reconciliation ${r.day} (${r.network}): ${r.pass ? "PASS" : "FAIL"}`,
    "",
    `- Runs: ${r.runs.completed} of ${r.runs.expected} expected (${r.runs.required} required), ${r.runs.failed} failed`,
    `- Unexplained differences: ${r.unexplained.differences} (max ${r.unexplained.centsMax} cents in one run, ${r.unexplained.centsLatest} in the last run)`,
  ];
  if (r.failReasons.length > 0) lines.push(`- Fail reasons: ${r.failReasons.join(", ")}`);
  const nonZero = (Object.entries(r.findings) as Array<[FindingKind, number]>).filter(([, n]) => n > 0);
  if (nonZero.length > 0) {
    lines.push("", "| Finding | Count | Meaning |", "|---|---|---|");
    for (const [k, n] of nonZero) lines.push(`| ${k} | ${n} | ${FINDING_KINDS[k].meaning} |`);
  }
  return `${lines.join("\n")}\n`;
}
