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

**Thresholds** (all three within a 45-day window):

1. At least EUR 7,000 in EURC released (primary).
2. At least 35 mainnet escrows funded and then released or resolved to the seller, from at least
   20 distinct buyer wallets.
3. At least 6 distinct sellers paid in EURC.

Silent-buyer resolutions count, are reported as a separate sub-count, and make up no more than
half of the counted escrows. Stretch goal (reported, not a condition): EUR 15,000 from 70 escrows.
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
   TODO(verify): confirm the exact event topics and payload of `tw_init`, `tw_release` and the
   resolution event against the deployed Wasm before Tranche 3.
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
