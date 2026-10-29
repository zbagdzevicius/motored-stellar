# examples/order-flow

One marketplace order, walked through every port of this repository. By default everything runs
in memory: no network, no keys on disk, no secrets. Every key is created with `Keypair.random()`
when the script starts and is gone when it exits.

Serves SCF deliverables **D4** (the mock half of the end-to-end test) and **D13** (a runnable
starting point for the integration guide).

## Run it

```bash
npm install                      # once, at the repository root
npm run example                  # in-memory, both scenarios
npm test -w @motored-stellar/example-order-flow
```

Against Stellar testnet (manual; never in CI):

```bash
npm run testnet:keys             # Keypair.random + friendbot, written only to .keys/ (git-ignored)
npm run testnet:deploy           # registry, guard, lab asset; IDs go to testnet-state.json (git-ignored)
npm run example -- --testnet [--silent-buyer]
```

`--testnet` hands over to [`scripts/testnet/e2e.ts`](../../scripts/testnet/e2e.ts), which runs the
same flows on Trustless Work's testnet Wasm with the guard holding both escrow roles, and prints
stellar.expert links.

## What it shows

**Scenario 1: buyer approves.**

1. `OrderSource` supplies a single-seller order (item EUR 180, shipping EUR 12, buyer fee EUR 5).
2. The fee rules compute `platform_fee_bps` so the seller nets at least the card-rail payout.
3. A Trustless Work escrow is created with the guard as `release_signer` and `dispute_resolver`;
   `guard.check_escrow` passes before the buyer sees anything.
4. The buyer's wallet (`WalletProvider`) reviews the decoded transaction and signs `fund_escrow`.
   The order is paid only because the buyer's own funding reached the amount.
5. `register_escrow` records `funded_at`.
6. The `DeliveryOracle` reports the parcel delivered; the anchoring job batches the claim and
   anchors the root in the registry.
7. The buyer approves; the guard's release branch authorises `release_funds`.
8. Anyone can re-check the claim against the registry.
9. The reconciler matches every EURC transfer to the ledger: **PASS**, 0 unexplained cents.

**Scenario 2a: silent buyer.** Same start. The buyer never approves. Three days after the claim
was anchored the guard refuses to pay the seller (`TooEarly` #10), refuses a claimless payout
(`NoClaim` #8) and a resolution signed with the wrong key. Seven days after the anchor, the platform
opens a dispute and the guard authorises a resolution to the seller, never more than the escrow
amount.

**Scenario 2b: refund with top-up.** The buyer disputes before release. The guard refuses a payout
to a third address (`BadRecipient` #9), then authorises the whole balance to the buyer. Trustless
Work withholds its 0.3% and the platform fee; the platform tops the buyer up by exactly those two
amounts, so the buyer gets 100% back. The reconciler counts it as a complete refund.

## How the pieces connect

| Port | In this example |
|---|---|
| `OrderSource` | `InMemoryOrderSource` (`@motored-stellar/escrow`) |
| `EscrowApi` | `InMemoryEscrowApi`, wrapped by `RecordingEscrowApi` so every landed transaction writes its EURC transfers into the reconciler's chain view |
| `WalletProvider` | `KeypairWallet` (`@motored-stellar/wallets`) with a review hook |
| `Signer`, `KeyStore` | `KeypairSigner` runtime keys for platform, release, resolver and break-glass |
| `DeliveryOracle`, registry | `InMemoryDeliveryOracle`, `InMemoryRegistry`, `ClaimAnchoringJob` (`@motored-stellar/claims`) |
| `Clock` | `SimClock`, one clock for all packages, moved by hand |
| `LedgerSource`, `ChainReader`, `ReportSink` | in-memory implementations from `@motored-stellar/reconciler` |
| Guard | `GuardModel`: a TypeScript mirror of the guard contract's decisions and error codes |

`GuardModel` exists only because the in-memory Trustless Work model has no Soroban host to run the
guard's `__check_auth`. The contract in [`contracts/guard`](../../contracts/guard) is the source of
truth and is tested against Trustless Work's deployed Wasm; the mirror does not model the Wasm and
token pins, the authorisation payload or the testnet fee-address argument.

## Tests

- `test/order-flow.test.ts`: both scenarios; asserts seller >= card net (and at most 1 bp + 2 units
  more), buyer refund = 100%, reconciler pass with 0 unexplained cents, claim verifies, and the
  guard refusals (#8, #9, #10, #13, #17, #24, #28, wrong key).
- `test/docs-lint.test.ts`: runs [`scripts/lint/docs-lint.mjs`](../../scripts/lint/docs-lint.mjs)
  over the whole repository (no em dashes, no secret-shaped strings, no committed `.env`, no banned
  terms) and checks that each rule fires on a seeded tree.
