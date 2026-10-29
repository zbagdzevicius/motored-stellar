# On-chain release metric (Tranche 3)

The metric is defined on public chain data only, and [`scripts/metric`](../scripts/metric)
recomputes it. Today the script reads events from Stellar RPC, which keeps them for a limited
window only (days, not the whole metric period), so a full recompute needs a public archive of
older events: SDF's Hubble dataset (Stellar history on BigQuery) holds them, but the script has no
adapter for it yet. Until it does, from the first mainnet escrow the platform will publish weekly signed snapshots of the
footprint's events, each taken while RPC still holds those ledgers, so anyone can check each
snapshot against RPC that week and then feed the snapshots to the script with `--observations`.

## Definition

**Type:** cumulative payment volume in EURC released from registered escrows.

A release **counts** when an escrow is:

1. released to the seller (`release_funds`), or
2. resolved to the seller through the guard (`resolve_dispute` with the seller as a recipient).

**Volume** is the gross amount leaving the escrow towards the seller side: for a release,
`escrow.amount` (seller net plus the Trustless Work fee plus the platform fee); for a resolution,
the seller's share of the distribution map. Refunds to the buyer do not count. Shipping is outside
the escrow amount: the buyer pays it to the platform address in the funding step (29 Oct 2026
design), so it is never in the counted volume. The floor numbers below are unchanged.

**Window:** an escrow counts when it is **funded** inside a 45-day funding window (starting at the
first funding of a counted escrow) and released or resolved to the seller within 14 days after
that window ends. The whole metric therefore closes 59 days after the first counted funding, and an
escrow funded late in the window still has time to close. The closing deadline is day 80 after the
Tranche 2 payment (week 26 at the latest), inside the 90-day tranche limit, so the funding window
must start by day 21 after that payment; if it cannot, pro-rated thresholds are agreed with SCF in
writing by day 21.

**Floor** (all three over the escrows so counted; the floor is the payment condition):

1. At least EUR 4,000 in EURC released (primary).
2. At least 20 mainnet escrows funded and then released or resolved to the seller, from at least
   12 distinct buyer wallets.
3. At least 4 distinct sellers paid in EURC.

Silent-buyer resolutions count, are reported as a separate sub-count, and make up no more than
two thirds of the counted escrows, so at least one third are buyer approvals (in code: counted
silent <= 2 x counted buyer-approved, earliest silent resolutions first). The cap was set from
measured buyer-confirmation behaviour; it was one half before 29 Oct 2026.

**Target** (reported, not a condition): EUR 7,000 from 35 escrows, at least 20 distinct buyer
wallets and 6 distinct sellers. **Stretch** (reported, not a condition): EUR 15,000 from 70 escrows.

Basis: the floor is sized on the current paid-order pace (the 1-15 October 2026 pace, about 8.6
orders a day, so about 390 orders funded in a 45-day window), assuming that eligible orders run
through the platform checkout, where EURC is offered; about 5% of them choosing EURC for the floor
and 9% for the target; and, because silent-buyer resolutions count for at most two thirds, at
least 7 of the 20 counted escrows settled on the buyer's own approval. The Tranche 2 recalibration re-bases the floor
on measured checkout volume, opt-in rate and buyer-approval rate: the pilot reports
platform-checkout order volume, EURC opt-in among eligible orders and the buyer-approval rate, and
if any is below the basis, SCF is asked in writing to re-base the floor on those figures before
Tranche 3; the floor stands unless SCF agrees.

In code: `METRIC_THRESHOLDS` in `packages/reconciler/src/metric.ts` is the floor and decides the
PASS/FAIL verdict printed by `scripts/metric`; `METRIC_TARGET` and the stretch values are reported
alongside it. `METRIC_WINDOW_DAYS` (45) and `METRIC_CLOSE_DAYS` (14) set the window; each escrow's
`fundedAt` is its first incoming transfer.

The number of new EURC-holding accounts the sponsor account sponsored is reported as information.

**Not counted:** test, team and related-party orders, which are listed separately.

## Footprint

Registered up front and published in this repository. The mainnet platform fee address and sponsor
account are created before the award, and the mainnet guard and registry contract IDs are fixed in
advance from the deployer account and a published salt (a Soroban contract ID depends only on the
network, the deployer and the salt), so all four can be registered at award time. A replacement
guard joins the footprint only with SCF's written acknowledgement.

| Item | Why |
|---|---|
| Platform fee address | Set as `platform` on every escrow; identifies the platform's escrows |
| Guard contract ID | `release_signer` and `dispute_resolver` on every escrow |
| Claim registry ID | Anchors the delivery claims behind silent-buyer resolutions |
| Sponsor account | Sponsors buyer and seller accounts (CAP-33) |
| Sponsored accounts | Listed as created |
| EURC asset | The measured asset |
| Escrow contract IDs | Added as created |

## How the script computes it

1. Read Trustless Work `tw_init` events whose platform is the registered platform address, to
   collect the escrow set (and cross-check it against the published escrow list).
2. Read `tw_release` events for those escrows: gross = `escrow.amount` at release.
3. Resolutions: Trustless Work's resolution event carries no amounts, so read the EURC SAC
   `transfer` events out of each resolved escrow in the same transaction, and sum the transfers to
   the escrow's stored seller (plus the fee legs attributed pro rata to the seller's share).
   Checked 29 Oct 2026: the topics `tw_init`, `tw_release` and `tw_disp_resolve` (the resolution
   event) are in both deployed Trustless Work Wasm files (testnet `7c3f7b2a`, mainnet `96d51751`,
   fetched by hash with [`fetch.sh`](../contracts/third_party/tw-wasm/fetch.sh)) and in Trustless
   Work's `events/handler.rs`. Their payloads (`tw_init` = vec[Escrow], `tw_release` = the release
   signer's address, `tw_disp_resolve` = vec[Escrow] with no amounts) are decoded by the event
   reader's unit tests from real testnet events captured on 24 Oct 2026
   ([`packages/escrow/test/fixtures`](../packages/escrow/test/fixtures)). Still open, as a
   scheduled D12 check on the live rollout: the topic count of SAC `transfer` events (4 since
   Protocol 23, asset last) on the history the indexer reads.
4. Distinct buyers and sellers come from the guard registration (`Reg.buyer`, `Reg.seller`) of each
   counted escrow.
5. Classify a resolution as silent-buyer when the guard authorised it on the claim path
   (`ResolveSeller`).

RPC keeps events for a limited window only, so a full recompute reads from an archive (SDF's Hubble
dataset, once an adapter exists) or from the weekly signed snapshots the platform will publish from the first mainnet escrow (D12); the
script takes an `EventSource` port for that reason. The RPC collector refuses a start ledger older
than the RPC's oldest ledger rather than silently undercounting.

## Real output on testnet (runs 4 to 7, 29 Oct 2026)

The script has been run against the real testnet escrows of runs 4 to 7 (one footprint per guard
deployment; files and the full table in [verification.md](verification.md#re-run-over-runs-4-to-7-29-oct-2026-after-run-7)).
Run 7 footprint, output as captured in [`runs/metric-output-run-7.txt`](runs/metric-output-run-7.txt)
before the funded-in-window rule (the current script prints the funding window and the closing
deadline on the `window:` line; the counts for these escrows are the same, since each closed
minutes after funding). The captured outputs also predate the change of the silent-buyer cap from
one half to two thirds; with one silent-buyer resolution and one buyer-approved release it counts
under either cap:

```
network: testnet
window: 2026-10-29T09:27:30.000Z .. 2026-12-13T09:27:30.000Z (45 days)
FAIL  EURC released: 200.0000000 (floor >= 4000, target 7000)
FAIL  escrows released or resolved to the seller: 2 (floor >= 20, target 35)
FAIL  distinct buyer wallets: 1 (floor >= 12, target 20)
FAIL  distinct sellers paid: 1 (floor >= 4, target 6)
info  silent-buyer resolutions: 1 counted of 1
info  excluded (test, team, related-party): 0; refunds ignored: 3
info  target (EUR 7,000 / 35 escrows / 20 buyers / 6 sellers): not met
info  stretch: volume not met, escrows not met
info  sponsored accounts: 0
info  dropped by footprint checks: 0
VERDICT: FAIL
```

The verdict is FAIL, as expected: these are a handful of test escrows funded by one test buyer in
a stand-in asset (XEUR), far below the floor. What the run shows is the counting on real chain
data: the release and the silent-buyer resolution count at their gross amount, the three refunds
are ignored, and the funded but unsettled escrow is not counted. The runs 4 to 6 footprint gives
300.0000000 over 3 escrows, also FAIL. The SAC `transfer` events of runs 4 to 7 matched the
four-topic filter, which settles the topic count on testnet; the D12 check above still applies to
the history the indexer reads on mainnet.

## Reconciliation report (published daily from Tranche 3)

A pass/fail line with a count of unexplained differences between on-chain balances and transfers
and the platform's ledger. No per-order rows. Produced by
[`packages/reconciler`](../packages/reconciler) through the `ReportSink` port.
