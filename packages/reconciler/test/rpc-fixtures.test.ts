/**
 * Pure decoders of the RPC adapter, checked against public testnet responses
 * captured in the lab (`getEvents` JSON-RPC results; no keys, no private data).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { coverageFromRawGetEvents, decodeTwFund, type RawRpcEvent } from "../src/adapters/rpc.js";
import { runOnce } from "../src/reconcile.js";
import { BUYER, ESCROW, MIN, T0, expected, onChain, world } from "./helpers.js";

const load = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as {
    result: { events: RawRpcEvent[]; oldestLedger: number; latestLedger: number };
  };

describe("RPC fixtures", () => {
  it("reads the retention window from a getEvents result", () => {
    const cov = coverageFromRawGetEvents(load("rpc-getevents-empty.json").result);
    expect(cov).toEqual({ oldestLedger: 5_248_531, latestLedger: 5_369_490, gaps: [] });
    // About 7 days of ledgers at ~5 s each.
    expect(cov.latestLedger - cov.oldestLedger).toBe(120_959);
  });

  it("a cursor older than that window fails reconciliation (event-gap rule)", async () => {
    const cov = coverageFromRawGetEvents(load("rpc-getevents-empty.json").result);
    const w = world();
    w.chain.putEscrow(ESCROW, onChain());
    w.chain.transfer({ txHash: "fund-1", closedAt: T0 - MIN, from: BUYER, to: ESCROW, amount: onChain().amount });
    w.ledger.put(expected());
    w.chain.coverage = cov;
    const r = await runOnce(w.deps, w.config, { cursorLedger: cov.oldestLedger - 10 });
    expect(r.failReasons).toContain("rpc_event_gap");
  });

  it("decodes Trustless Work tw_fund events", () => {
    const events = load("rpc-getevents-tw-fund.json").result.events;
    expect(events).toHaveLength(3);
    const first = decodeTwFund(events[0] as RawRpcEvent);
    expect(first).toEqual({
      escrowId: "CBKKVPHHQIKR76RVFNNXXV73HZLON7IOS7IOKMNG4ZXZJHPNGHFC2F3W",
      signer: "GAJNTKOPP733TXDRBLPAVKA6TS3KQMR2HNXAEPLCL3WSXIW6EFDQOL5U",
      amount: 2999n,
      txHash: "f7b07c7351e839ee9c0802293819bb9a1f8fcc2e648811d35218bb5c2231b968",
      ledger: 5_252_970,
      closedAt: Date.parse("2026-10-18T01:53:57Z"),
    });
  });
});
