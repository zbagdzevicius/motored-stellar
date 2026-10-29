import { describe, expect, it } from "vitest";
import { runOnce } from "../src/reconcile.js";
import { eur } from "../src/units.js";
import {
  AMOUNT,
  BUYER,
  ESCROW,
  MIN,
  PLATFORM,
  SELLER,
  T0,
  THIRD,
  TW_FEE,
  expected,
  landExit,
  onChain,
  world,
} from "./helpers.js";

/** A world with one escrow the buyer funded in full ten minutes ago. */
function funded() {
  const w = world();
  w.chain.putEscrow(ESCROW, onChain());
  w.chain.transfer({ txHash: "fund-1", closedAt: T0 - 10 * MIN, from: BUYER, to: ESCROW, amount: AMOUNT });
  return w;
}

const kinds = (r: { findings: Array<{ kind: string }> }) => r.findings.map((f) => f.kind);

describe("matched ledger", () => {
  it("a funded, released escrow reconciles with zero unexplained cents", async () => {
    const w = funded();
    const e = expected({
      status: "released",
      exits: [{ kind: "release", txHash: "rel-1", submittedAt: T0 - 5 * MIN, toBuyer: 0n, toSeller: AMOUNT }],
    });
    w.ledger.put(e);
    landExit(w.chain, e, 0, T0 - 4 * MIN);
    w.chain.setFlags(ESCROW, { released: true });

    const r = await runOnce(w.deps, w.config);
    expect(r.findings).toEqual([]);
    expect(r.unexplainedCents).toBe(0n);
    expect(r.pass).toBe(true);
    expect(r.openValueUnits).toBe(0n);
    expect(w.sink.alerts).toEqual([]);
  });

  it("a funded, open escrow reconciles and counts toward open value", async () => {
    const w = funded();
    w.ledger.put(expected());
    const r = await runOnce(w.deps, w.config);
    expect(r.pass).toBe(true);
    expect(r.openValueUnits).toBe(AMOUNT);
  });
});

describe("D12 named failure states", () => {
  it("release reverted: classified, money explained, P1 alert raised", async () => {
    const w = funded();
    w.ledger.put(
      expected({
        status: "release_submitted",
        exits: [{ kind: "release", txHash: "rel-1", submittedAt: T0 - 5 * MIN, toBuyer: 0n, toSeller: AMOUNT }],
      }),
    );
    w.chain.setTx("rel-1", "failed");

    const r = await runOnce(w.deps, w.config);
    expect(kinds(r)).toEqual(["release_reverted"]);
    expect(r.findings[0]?.explainedUnits).toBe(AMOUNT);
    expect(r.unexplainedCents).toBe(0n);
    expect(w.sink.alerts.map((a) => [a.severity, a.kind])).toEqual([["P1", "release_reverted"]]);
  });

  it("release never landed: pending within grace, reverted after it", async () => {
    const w = funded();
    w.ledger.put(
      expected({
        status: "release_submitted",
        exits: [{ kind: "release", txHash: "rel-1", submittedAt: T0 - 2 * MIN, toBuyer: 0n, toSeller: AMOUNT }],
      }),
    );
    expect(kinds(await runOnce(w.deps, w.config))).toEqual(["exit_pending"]);
    w.clock.advance(30 * MIN);
    expect(kinds(await runOnce(w.deps, w.config))).toEqual(["release_reverted"]);
  });

  it("funding below the escrow amount", async () => {
    const w = world();
    w.chain.putEscrow(ESCROW, onChain());
    w.chain.transfer({ txHash: "fund-1", closedAt: T0 - MIN, from: BUYER, to: ESCROW, amount: eur("84") });
    w.ledger.put(expected({ status: "awaiting_funds" }));

    const r = await runOnce(w.deps, w.config);
    expect(kinds(r)).toEqual(["partial_funding"]);
    expect(r.findings[0]?.explainedUnits).toBe(eur("84"));
    expect(r.unexplainedCents).toBe(0n);
  });

  it("excess funding: buyer overpays, third-party dust, and a balance left after release", async () => {
    const w = funded();
    w.chain.transfer({ txHash: "fund-2", closedAt: T0 - 9 * MIN, from: BUYER, to: ESCROW, amount: eur("1.5") });
    w.chain.transfer({ txHash: "dust-1", closedAt: T0 - 8 * MIN, from: THIRD, to: ESCROW, amount: 1n });
    w.ledger.put(expected());
    let r = await runOnce(w.deps, w.config);
    expect(kinds(r)).toEqual(["excess_funding", "excess_funding"]);
    expect(r.findings.map((f) => f.explainedUnits)).toEqual([eur("1.5"), 1n]);
    expect(r.unexplainedCents).toBe(0n);

    // Release pays exactly the amount; the excess stays and is flagged for withdrawal.
    const e = expected({
      status: "released",
      exits: [{ kind: "release", txHash: "rel-1", submittedAt: T0 - 5 * MIN, toBuyer: 0n, toSeller: AMOUNT }],
    });
    w.ledger.put(e);
    landExit(w.chain, e, 0, T0 - 4 * MIN);
    w.chain.setFlags(ESCROW, { released: true });
    r = await runOnce(w.deps, w.config);
    expect(kinds(r)).toEqual(["excess_funding"]);
    expect(r.findings[0]?.explainedUnits).toBe(eur("1.5") + 1n);
    expect(r.pass).toBe(true);
  });

  it("SEPA funds after order expiry: late escrow funding and a late ramp deposit", async () => {
    const w = funded();
    w.ledger.put(
      expected({
        status: "expired",
        paymentDeadline: T0 - 60 * MIN,
        rampDeposits: [{ amount: eur("50"), arrivedAt: T0 - 30 * MIN }],
      }),
    );
    const r = await runOnce(w.deps, w.config);
    expect(kinds(r)).toEqual(["sepa_after_expiry", "sepa_after_expiry"]);
    expect(r.findings.map((f) => f.explainedUnits)).toEqual([AMOUNT, eur("50")]);
    expect(r.unexplainedCents).toBe(0n);
  });

  it("frozen balance", async () => {
    const w = funded();
    w.chain.freeze(ESCROW);
    w.ledger.put(expected());
    const r = await runOnce(w.deps, w.config);
    expect(kinds(r)).toEqual(["frozen_balance"]);
    expect(w.sink.alerts[0]?.severity).toBe("P1");
  });

  it("fee account without trustline fails the run and names the likely cause of a revert", async () => {
    const w = funded();
    w.chain.setTrustline(TW_FEE, { exists: false, authorized: false });
    w.ledger.put(
      expected({
        status: "release_submitted",
        exits: [{ kind: "release", txHash: "rel-1", submittedAt: T0 - 5 * MIN, toBuyer: 0n, toSeller: AMOUNT }],
      }),
    );
    w.chain.setTx("rel-1", "failed");
    const r = await runOnce(w.deps, w.config);
    expect(r.pass).toBe(false);
    expect(r.failReasons).toEqual(["fee_account_no_trustline"]);
    expect(r.findings.find((f) => f.kind === "release_reverted")?.message).toMatch(/fee account without trustline/);
  });

  it("fee account with a de-authorised trustline also fails", async () => {
    const w = funded();
    w.chain.setTrustline(PLATFORM, { exists: true, authorized: false });
    w.ledger.put(expected());
    const r = await runOnce(w.deps, w.config);
    expect(r.failReasons).toEqual(["fee_account_no_trustline"]);
  });

  describe("RPC event gap never passes silently", () => {
    it("cursor older than the reader's retention", async () => {
      const w = funded();
      w.ledger.put(expected());
      w.chain.coverage = { oldestLedger: 5_000, latestLedger: 6_000, gaps: [] };
      const r = await runOnce(w.deps, w.config, { cursorLedger: 100 });
      expect(r.pass).toBe(false);
      expect(r.failReasons).toContain("rpc_event_gap");
      expect(r.findings[0]?.message).toMatch(/101 to 4999/);
      expect(r.nextCursorLedger).toBe(6_000);
    });

    it("cursor inside retention passes", async () => {
      const w = funded();
      w.ledger.put(expected());
      w.chain.coverage = { oldestLedger: 5_000, latestLedger: 6_000, gaps: [] };
      const r = await runOnce(w.deps, w.config, { cursorLedger: 5_500 });
      expect(r.pass).toBe(true);
    });

    it("reader-reported gap", async () => {
      const w = funded();
      w.ledger.put(expected());
      w.chain.coverage = { oldestLedger: 1, latestLedger: 900, gaps: [{ fromLedger: 10, toLedger: 20 }] };
      const r = await runOnce(w.deps, w.config);
      expect(r.failReasons).toEqual(["rpc_event_gap"]);
    });

    it("balance that net transfers do not explain (a missed event)", async () => {
      const w = funded();
      w.chain.setBalance(ESCROW, AMOUNT + eur("3"));
      w.ledger.put(expected());
      const r = await runOnce(w.deps, w.config);
      expect(kinds(r)).toContain("rpc_event_gap");
      expect(r.unexplainedCents).toBe(300n);
      expect(r.pass).toBe(false);
    });

    it("unreadable chain or ledger becomes read_error, not a pass", async () => {
      const w = funded();
      w.ledger.put(expected());
      w.chain.getEventCoverage = async () => {
        throw new Error("rpc down");
      };
      let r = await runOnce(w.deps, w.config);
      expect(r.failReasons).toEqual(["read_error"]);

      const w2 = funded();
      w2.ledger.failWith = new Error("db down");
      r = await runOnce(w2.deps, w2.config);
      expect(r.pass).toBe(false);
      expect(r.failReasons).toEqual(["read_error"]);
    });
  });
});

describe("refunds and top-ups", () => {
  function refunded(topUp: { txHash?: string; amount?: bigint }) {
    const w = funded();
    const e = expected({
      status: "resolved",
      exits: [{ kind: "resolution", txHash: "res-1", submittedAt: T0 - 5 * MIN, toBuyer: AMOUNT, toSeller: 0n }],
      topUps: topUp.txHash ? [{ exitTxHash: "res-1", txHash: topUp.txHash }] : [],
    });
    w.ledger.put(e);
    landExit(w.chain, e, 0, T0 - 4 * MIN);
    w.chain.setFlags(ESCROW, { disputed: false, resolved: true });
    if (topUp.txHash && topUp.amount !== undefined) {
      w.chain.transfer({ txHash: topUp.txHash, closedAt: T0 - 3 * MIN, from: PLATFORM, to: BUYER, amount: topUp.amount });
    }
    return w;
  }

  it("the top-up line reconciles the refund to 100%", async () => {
    // Fees on EUR 210 at 1180 bps: 6,300,000 + 247,800,000 units.
    const w = refunded({ txHash: "top-1", amount: 254_100_000n });
    const r = await runOnce(w.deps, w.config);
    expect(r.findings).toEqual([]);
    expect(r.refundsComplete).toBe(1);
    expect(r.pass).toBe(true);

    const toBuyer = (await w.chain.getTransfers(BUYER)).filter((t) => t.to === BUYER && t.from !== BUYER);
    const received = toBuyer.reduce((a, t) => a + t.amount, 0n);
    expect(received).toBe(AMOUNT);
  });

  it("a top-up still inside its grace period is pending, not a failure", async () => {
    const w = refunded({});
    const r = await runOnce(w.deps, w.config);
    expect(kinds(r)).toEqual(["topup_pending"]);
    expect(r.pass).toBe(true);
  });

  it("an overdue top-up is unexplained money", async () => {
    const w = refunded({});
    w.clock.advance(2 * 60 * MIN);
    const r = await runOnce(w.deps, w.config);
    expect(kinds(r)).toEqual(["topup_missing"]);
    expect(r.unexplainedCents).toBe(2541n);
    expect(r.failReasons).toEqual(["unexplained_cents"]);
  });

  it("a top-up of the wrong amount is flagged to the unit", async () => {
    const w = refunded({ txHash: "top-1", amount: 254_100_000n - 1n });
    const r = await runOnce(w.deps, w.config);
    expect(kinds(r)).toEqual(["topup_mismatch"]);
    expect(r.findings[0]?.unexplainedUnits).toBe(1n);
    expect(r.unexplainedCents).toBe(1n);
  });
});

describe("unexplained money and integrity", () => {
  it("a transfer out of the escrow in an unknown tx is unexplained", async () => {
    const w = funded();
    w.chain.transfer({ txHash: "x-1", closedAt: T0 - MIN, from: ESCROW, to: THIRD, amount: eur("10") });
    w.ledger.put(expected());
    const r = await runOnce(w.deps, w.config);
    expect(kinds(r)).toContain("unexplained_transfer");
    expect(r.unexplainedCents).toBe(1000n);
    expect(r.pass).toBe(false);
  });

  it("a release leg short by one unit is caught (sub-cent rounds up to one cent)", async () => {
    const w = funded();
    w.ledger.put(
      expected({
        status: "released",
        exits: [{ kind: "release", txHash: "rel-1", submittedAt: T0 - 5 * MIN, toBuyer: 0n, toSeller: AMOUNT }],
      }),
    );
    w.chain
      .transfer({ txHash: "rel-1", closedAt: T0 - 4 * MIN, from: ESCROW, to: TW_FEE, amount: 6_300_000n })
      .transfer({ txHash: "rel-1", closedAt: T0 - 4 * MIN, from: ESCROW, to: PLATFORM, amount: 247_800_000n - 1n })
      .transfer({ txHash: "rel-1", closedAt: T0 - 4 * MIN, from: ESCROW, to: SELLER, amount: 1_845_900_000n })
      .setFlags(ESCROW, { released: true });
    const r = await runOnce(w.deps, w.config);
    expect(kinds(r).sort()).toEqual(["excess_funding", "missing_transfer"]);
    expect(r.unexplainedCents).toBe(1n);
    expect(r.pass).toBe(false);
  });

  it("ledger says released but the escrow flag is not set", async () => {
    const w = funded();
    w.ledger.put(expected({ status: "released" }));
    const r = await runOnce(w.deps, w.config);
    expect(r.failReasons).toEqual(["ledger_chain_mismatch"]);
  });

  it("an escrow whose platform role is not ours fails the run", async () => {
    const w = funded();
    w.chain.putEscrow(ESCROW, onChain({ platform: THIRD }));
    w.ledger.put(expected());
    const r = await runOnce(w.deps, w.config);
    expect(r.failReasons).toEqual(["escrow_mismatch"]);
  });

  it("an escrow missing on chain is a read error", async () => {
    const w = world();
    w.ledger.put(expected({ escrowId: "C_MISSING" }));
    const r = await runOnce(w.deps, w.config);
    expect(r.failReasons).toEqual(["read_error"]);
  });
});

describe("caps (config defaults EUR 1,000 per order, EUR 5,000 open value)", () => {
  it("open value above the cap fails the run", async () => {
    const w = world();
    for (let i = 0; i < 25; i++) {
      const id = `C_ESCROW_OPEN_${i}`;
      w.chain.putEscrow(id, onChain());
      w.chain.transfer({ txHash: `fund-${i}`, closedAt: T0 - MIN, from: BUYER, to: id, amount: AMOUNT });
      w.ledger.put(expected({ escrowId: id, orderRef: `ref-${i}` }));
    }
    const r = await runOnce(w.deps, w.config);
    expect(r.openValueUnits).toBe(AMOUNT * 25n);
    expect(r.failReasons).toEqual(["open_value_cap_exceeded"]);
  });

  it("per-order amount above the cap fails the run", async () => {
    const w = world();
    const big = eur("1200");
    w.chain.putEscrow(ESCROW, onChain({ amount: big }));
    w.chain.transfer({ txHash: "fund-1", closedAt: T0 - MIN, from: BUYER, to: ESCROW, amount: big });
    w.ledger.put(expected({ amount: big }));
    const r = await runOnce(w.deps, w.config);
    expect(r.failReasons).toEqual(["per_order_cap_exceeded"]);
  });

  it("caps are configurable", async () => {
    const w = world();
    const big = eur("1200");
    w.chain.putEscrow(ESCROW, onChain({ amount: big }));
    w.chain.transfer({ txHash: "fund-1", closedAt: T0 - MIN, from: BUYER, to: ESCROW, amount: big });
    w.ledger.put(expected({ amount: big }));
    const r = await runOnce(w.deps, { ...w.config, perOrderCap: eur("2000") });
    expect(r.pass).toBe(true);
  });
});
