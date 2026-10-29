# @motored-stellar/reconciler

Reconciliation, daily reporting and the on-chain metric for Trustless Work v1
single-release escrows settled in EURC.

Every 15 minutes the host calls `runOnce()`. For every escrow its ledger lists,
the reconciler compares the on-chain EURC balance, the Trustless Work flags,
every EURC transfer in and out of the escrow, and each refund top-up against
the expected ledger, to the base unit (0.0000001 EURC). Each difference is
classified; money that no classification explains is counted as unexplained
cents. Once a day, `buildDailyReport()` folds the runs into a pass/fail report
with counts and no per-order rows, which is safe to publish.

The package also exports `computeMetric()`, the pure computation behind
`scripts/metric` (the Tranche 3 on-chain metric).

## SCF deliverables served

| Deliverable | What this package provides |
|---|---|
| Reconciliation (Motored-funded, not billed since the 29 Oct 2026 budget cut) | The reconciliation rule (run every 15 minutes on testnet escrows): fee legs predicted with Trustless Work's own arithmetic (`tw-math.ts`), rounding in the recipient's favour predicted exactly, refund top-ups on their own line |
| D7 monitoring plan (policies run by Motored) | Alert hooks: every P1/P2 finding goes to `ReportSink.alert` (stuck or reverted exits, reconciliation gaps, transfers out of escrows with no matching record, fee-account trustlines, frozen balances, caps) |
| D12 rollout | The named failure states (billed); the 15-minute reconciliation in production, the daily pass/fail report and the metric computation (Motored-funded, not billed, still run and published) |

## Ports

Nothing here talks to a database, a scheduler or a specific provider. The host
plugs in through `src/ports.ts`; every port has an in-memory implementation in
`src/memory.ts`.

| Port | Role | Implementations |
|---|---|---|
| `LedgerSource` | Expected escrows: amount, fee bps, buyer, seller, status, submitted exits, top-ups, ramp deposits | `InMemoryLedgerSource` |
| `ChainReader` | Escrow state, SAC balance and freeze, EURC transfers, tx status, trustlines, event coverage | `InMemoryChainReader`, `RpcChainReader` |
| `ReportSink` | Daily report out, internal alerts out | `InMemoryReportSink`, `ConsoleReportSink`, `FileReportSink` |
| `Clock` | Time, epoch ms | `ManualClock` |

`RpcChainReader` reads Soroban RPC directly. RPC keeps events for a limited
window (about 7 days on public testnet), so it reports anything older than
that as a gap and the run fails. For production history, put an indexer behind
the same `ChainReader` interface.

## Findings

The first seven are the D12 named failure states.

| Kind | Blocking | Meaning |
|---|---|---|
| `release_reverted` | no | A submitted release, resolution or withdrawal failed or never landed; funds still in the escrow |
| `partial_funding` | no | Buyer funded less than the amount; refunded through a dispute |
| `excess_funding` | no | Buyer overpaid, third-party dust, or a balance left after release |
| `sepa_after_expiry` | no | Funds arrived after the payment deadline |
| `frozen_balance` | no | The issuer froze the escrow's EURC balance |
| `fee_account_no_trustline` | yes | A fee account cannot receive EURC, so every exit reverts |
| `rpc_event_gap` | yes | History past retention, a reader-reported gap, or a balance net transfers do not explain |
| `unexplained_transfer`, `missing_transfer` | money | A leg that the fee arithmetic does not predict, or a predicted leg that is missing |
| `exit_pending`, `topup_pending` | no | Inside the grace period |
| `topup_missing`, `topup_mismatch` | money | The buyer is not made whole after a refund |
| `escrow_mismatch`, `ledger_chain_mismatch` | yes | The chain and the ledger disagree on the escrow itself |
| `per_order_cap_exceeded`, `open_value_cap_exceeded` | yes | Checkout caps breached (defaults EUR 1,000 and EUR 5,000, configurable) |
| `read_error` | yes | The chain or ledger could not be read |

A run passes only with zero unexplained cents and no blocking finding.
Unexplained units round up to whole cents, so a single base unit still shows.
A day passes only if at least 95% of the expected 96 runs completed and every
run passed.

## Usage

```ts
import { makeConfig, runOnce, buildDailyReport, RpcChainReader, FileReportSink } from "@motored-stellar/reconciler";

const config = makeConfig({ platformAccount: "G...", trustlessWorkFeeAccount: "G..." });
const chain = new RpcChainReader({
  rpcUrl: "https://soroban-testnet.stellar.org",
  eurcSac: "C...",
  eurc: { code: "EURC", issuer: "G..." },
  startLedger: 0,
});
const sink = new FileReportSink({ reportDir: "reports/public", alertFile: ".private/alerts.jsonl" });

// Your scheduler, every 15 minutes:
const run = await runOnce({ ledger: myLedgerSource, chain, clock: { now: Date.now }, sink }, config, { cursorLedger });
cursorLedger = run.nextCursorLedger;

// Once a day:
await sink.writeDaily(buildDailyReport(todaysRuns, { day: "2027-01-10", network: "testnet" }));
```

Alerts can name escrow IDs and order references, so they go to a private
channel. The daily report contains only counts.

## Metric

`computeMetric()` takes normalised `tw_init` escrows, `tw_release` and
`tw_disp_resolve` events and EURC transfers out of escrows, and returns
aggregates only. It applies the published definition:

- A release counts at gross (`escrow.amount`). A resolution counts when it pays
  the seller, measured from the EURC transfers of that transaction, because the
  resolution event carries no amounts. Refunds do not count.
- Floor (the pass/fail condition): at least EUR 4,000 released; at least 20
  escrows from at least 12 distinct buyer wallets; at least 4 distinct sellers.
  The target (EUR 7,000, 35 escrows, 20 wallets, 6 sellers) and the stretch goal
  (EUR 15,000, 70 escrows) are reported but are not conditions.
- Silent-buyer resolutions are reported as a sub-count. They count only up to
  twice the number of counted buyer-approved escrows (`SILENT_PER_APPROVED`),
  so they never make up more than two thirds; the earliest count first. The
  cap was set from measured buyer-confirmation behaviour.
- Only escrows whose `platform` is the registered address count, and the caller
  can mark test or related-party escrows as `excluded`.

## Test

```bash
npm test --workspace @motored-stellar/reconciler
npm run typecheck --workspace @motored-stellar/reconciler
```

The tests use the in-memory ports and two public testnet RPC responses in
`test/fixtures` (a `getEvents` retention window and three `tw_fund` events).
No network access and no keys are needed.

## Provenance

No reconciler existed in the lab, so this is new code. The rules come from the
architecture's money-and-ledger and failure-mode sections (see
`docs/architecture.md`). The fee arithmetic mirrors the Trustless Work v1
contract (`calculator.rs`, `distribution.rs`) and its Python property check.
