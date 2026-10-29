# On-chain release metric (Tranche 3)

The metric is defined so that anyone can recompute it from public chain data with
[`scripts/metric`](../scripts/metric), without access to the marketplace's systems.

## Definition

**Type:** cumulative payment volume in EURC released from registered escrows.

A release **counts** when an escrow is:

1. released to the seller (`release_funds`), or
2. resolved to the seller through the guard (`resolve_dispute` with the seller as a recipient).

**Volume** is the gross amount leaving the escrow towards the seller side: for a release,
`escrow.amount` (seller net plus the Trustless Work fee plus the platform fee); for a resolution,
the seller's share of the distribution map. Refunds to the buyer do not count.

**Floor** (all three within a 45-day window; the floor is the payment condition):

1. At least EUR 4,000 in EURC released (primary).
2. At least 20 mainnet escrows funded and then released or resolved to the seller, from at least
   12 distinct buyer wallets.
3. At least 4 distinct sellers paid in EURC.

Silent-buyer resolutions count, are reported as a separate sub-count, and make up no more than
half of the counted escrows.

**Target** (reported, not a condition): EUR 7,000 from 35 escrows, at least 20 distinct buyer
wallets and 6 distinct sellers. **Stretch** (reported, not a condition): EUR 15,000 from 70 escrows.

If the opt-in measured in the Tranche 2 pilot is below the basis behind these numbers (about 5% of
orders for the floor, 9% for the target), it is reported and SCF is asked in writing to recalibrate
before Tranche 3; the floor stands unless SCF agrees.

In code: `METRIC_THRESHOLDS` in `packages/reconciler/src/metric.ts` is the floor and decides the
PASS/FAIL verdict printed by `scripts/metric`; `METRIC_TARGET` and the stretch values are reported
alongside it.

The number of new EURC-holding accounts the sponsor account sponsored is reported as information.

**Not counted:** test, team and related-party orders, which are listed separately.

## Footprint

Registered up front and published in this repository:

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

RPC keeps events for a limited window only, so a full recompute reads from an indexer or from the
event store the platform publishes; the script takes an `EventSource` port for that reason.

## Reconciliation report (published daily from Tranche 3)

A pass/fail line with a count of unexplained differences between on-chain balances and transfers
and the platform's ledger. No per-order rows. Produced by
[`packages/reconciler`](../packages/reconciler) through the `ReportSink` port.
