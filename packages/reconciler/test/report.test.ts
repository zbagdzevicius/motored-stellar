import { describe, expect, it } from "vitest";
import { runOnce, type RunResult } from "../src/reconcile.js";
import { buildDailyReport, renderDailyMarkdown } from "../src/report.js";
import { FileReportSink } from "../src/adapters/sinks.js";
import { BUYER, ESCROW, MIN, T0, THIRD, expected, onChain, world } from "./helpers.js";
import { eur } from "../src/units.js";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DAY = "2026-11-02";

/** Run the reconciler every 15 minutes for a whole day. */
async function day(setup: (w: ReturnType<typeof world>) => void, runs = 96): Promise<RunResult[]> {
  const w = world();
  setup(w);
  const out: RunResult[] = [];
  for (let i = 0; i < runs; i++) {
    w.clock.set(T0 + i * 15 * MIN);
    out.push(await runOnce(w.deps, w.config));
  }
  return out;
}

function fundedOpen(w: ReturnType<typeof world>) {
  w.chain.putEscrow(ESCROW, onChain());
  w.chain.transfer({ txHash: "fund-1", closedAt: T0 - MIN, from: BUYER, to: ESCROW, amount: eur("210") });
  w.ledger.put(expected());
}

describe("daily report", () => {
  it("a clean day passes with zero unexplained differences", async () => {
    const report = buildDailyReport(await day(fundedOpen), { day: DAY, network: "testnet" });
    expect(report.pass).toBe(true);
    expect(report.failReasons).toEqual([]);
    expect(report.runs).toEqual({ expected: 96, required: 92, completed: 96, failed: 0 });
    expect(report.unexplained).toEqual({ differences: 0, centsMax: "0", centsLatest: "0" });
  });

  it("missed runs fail the day even when every run passed", async () => {
    const report = buildDailyReport(await day(fundedOpen, 40), { day: DAY, network: "testnet" });
    expect(report.pass).toBe(false);
    expect(report.failReasons).toEqual(["missed_runs"]);
  });

  it("a persisting difference counts once per escrow, not once per run", async () => {
    const runs = await day((w) => {
      fundedOpen(w);
      w.chain.transfer({ txHash: "x-1", closedAt: T0 - MIN, from: ESCROW, to: THIRD, amount: eur("10") });
    });
    const report = buildDailyReport(runs, { day: DAY, network: "testnet" });
    expect(report.pass).toBe(false);
    expect(report.failReasons).toEqual(["unexplained_cents"]);
    expect(report.unexplained).toEqual({ differences: 1, centsMax: "1000", centsLatest: "1000" });
    expect(report.findings.unexplained_transfer).toBe(1);
  });

  it("runs from other days are ignored", async () => {
    const runs = await day(fundedOpen);
    const report = buildDailyReport(runs, { day: "2026-11-03", network: "testnet" });
    expect(report.runs.completed).toBe(0);
    expect(report.pass).toBe(false);
  });

  it("output carries aggregates only: no escrow IDs, order refs, addresses or tx hashes", async () => {
    const runs = await day((w) => {
      fundedOpen(w);
      w.chain.transfer({ txHash: "x-1", closedAt: T0 - MIN, from: ESCROW, to: THIRD, amount: eur("10") });
      w.chain.freeze(ESCROW);
    });
    const report = buildDailyReport(runs, { day: DAY, network: "testnet" });
    const json = JSON.stringify(report);
    const md = renderDailyMarkdown(report);
    for (const text of [json, md]) {
      for (const secret of [ESCROW, "order-ref-1", BUYER, THIRD, "x-1", "fund-1", "C_", "G_"]) {
        expect(text).not.toContain(secret);
      }
    }
    expect(Object.keys(report).sort()).toEqual(
      ["day", "failReasons", "findings", "network", "pass", "runs", "schema", "unexplained"].sort(),
    );
    expect(report.findings.frozen_balance).toBe(1);
  });

  it("the file sink writes the public report and keeps alerts in a separate file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reconciler-"));
    const sink = new FileReportSink({ reportDir: join(dir, "public"), alertFile: join(dir, "private", "alerts.jsonl") });
    const w = world();
    fundedOpen(w);
    w.chain.freeze(ESCROW);
    const run = await runOnce({ ...w.deps, sink }, w.config);
    await sink.writeDaily(buildDailyReport([run], { day: DAY, network: "testnet", expectedRuns: 1 }));

    const pub = await readFile(join(dir, "public", `${DAY}.json`), "utf8");
    expect(JSON.parse(pub).pass).toBe(true);
    expect(pub).not.toContain(ESCROW);
    const alerts = await readFile(join(dir, "private", "alerts.jsonl"), "utf8");
    expect(alerts).toContain("frozen_balance");
  });
});
