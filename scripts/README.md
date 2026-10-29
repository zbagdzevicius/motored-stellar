# @motored-stellar/scripts

Runnable command-line tools for the escrow rail: create testnet keys, deploy, run an end-to-end order, recompute the Tranche 3 on-chain metric, and re-check a delivery claim.

Deploy and e2e work on **testnet only**. Each one checks the network passphrase and RPC URL, then asks the RPC server which network it serves, and stops on anything other than testnet. The metric and re-check scripts are read-only. They can read mainnet through an explicit `--rpc`, but they never sign or submit anything.

| Script | What it does | SCF deliverable |
|---|---|---|
| `testnet/keys.ts` | Generates every role at runtime, saves it to `.keys/testnet.json` and funds the accounts through friendbot. Prints G-addresses and guard public keys only. | D13 testnet demo |
| `testnet/deploy.ts` | Sets up a stand-in XEUR issuer, trustlines and its SAC (or, with `--asset CODE:ISSUER`, trustlines to an existing asset such as Circle's testnet EURC). Deploys the claim registry. Uploads the guard through a fee-bump and deploys it with `Cfg` pinned to Trustless Work testnet Wasm `7c3f7b2a...`. Deploys a Trustless Work deployer instance. Writes the resulting IDs to `testnet-state.json`. | D13 |
| `testnet/e2e.ts` | Runs orders on testnet: release with an anchored claim, dispute then refund plus top-up, and a partial-funding break-glass refund. `--silent-buyer` adds a claim-based seller payout. Prints stellar.expert links and exports the run log to `scripts/out/`. | D4 (public half), D13 |
| `testnet/e2e-claims.ts` | The two claim flows: a silent buyer whose seller is paid through dispute resolution against a delivery claim anchored with a 32-level Merkle proof (verified in the guard's `__check_auth`) after the payout delay, and a buyer contest on the guard that blocks the seller payout and ends in a full refund plus top-up. Waits out the 120 s windows once for both. Shared steps live in `testnet/order-kit.ts`. | D4 (public half), D6, D13 |
| `testnet/refusals.ts` | Lands refused payouts as failed transactions with the guard's error code: wrong fee address (15), seller payout without a claim (8), break-glass to the seller (13), seller payout during a buyer contest (25). Submits only after the enforce-mode simulation fails with the expected code, with a footprint built from the refused call and the accepted alternative on the same escrow; reads the code back from the ledger's diagnostic events. Each escrow is then settled the legitimate way. | D6 (pre-award part), D13 |
| `metric/index.ts` | Recomputes the Tranche 3 metric from a footprint file and prints PASS or FAIL. | D12 |
| `claims/recheck.ts` | Re-checks a released order's delivery claim against the registry, using the published leaf format. | D6 |

## Keys and secrets

- Keys are generated when you run `keys.ts`. Accounts get random ed25519 seeds. The release, resolver and break-glass guard keys get 32 random bytes each. The lab derived its guard keys from fixed seeds, which are public, so this repo does not use them.
- Key material is written only to `<repo>/.keys/testnet.json`, with mode 0600. The root `.gitignore` excludes `.keys/`, and the directory also holds its own `*` ignore file. `FileKeyStore` refuses any path outside that directory.
- Nothing prints a secret. Use `publicView()` for anything that reaches a terminal.
- `testnet-state.json` holds only public contract IDs and claims, and is git-ignored. Run logs in `scripts/out/` hold only public transaction hashes; the run 4-6 logs are committed in `docs/runs/`.

## Quickstart (testnet)

```bash
# Build the contracts first (Cargo workspace in contracts/).
(cd contracts && stellar contract build)   # or: cargo build --target wasm32v1-none --release
# Optional, makes the guard upload cheaper:
stellar contract optimize --wasm contracts/target/wasm32v1-none/release/motored_escrow_guard.wasm \
  --wasm-out contracts/target/wasm32v1-none/release/motored_escrow_guard.optimized.wasm

cd scripts
npm run testnet:keys              # fresh roles + friendbot
npm run testnet:deploy            # delay = contest window = 120 s for the demo (production: 7 days)
npm run testnet:e2e               # add -- --silent-buyer to wait for the claim delay
npm run testnet:e2e-claims        # silent buyer + buyer contest (about 4 minutes)
npm run testnet:refusals          # refused payouts landed as failed txs (about 3 minutes)
npm run claims:recheck -- --from-state
```

Set `MS_TESTNET_RPC` to use a different testnet RPC. The network guard still applies.

## Real testnet EURC

`deploy.ts --asset CODE:ISSUER` runs the same deployment on an existing classic asset instead of the XEUR stand-in. For Circle's testnet EURC the issuer is `GB3Q6QDZYTHWT7E5PVS3W7FUT5GVAFC5KSZFFLPU25GO7VTC3NM2ZTVO` (source: https://developers.circle.com/stablecoins/eurc-contract-addresses; its Horizon testnet `home_domain` is `circle.com`). The mainnet EURC issuer is refused. Nothing is issued: the five trustlines are added, the existing SAC (`CCUUDM434BMZMYWYDITHFXHDMIVTGGD6T2I5UKNX5BSLXLW7HVR4MCGZ`) is resolved, and the buyer is funded from https://faucet.circle.com (Stellar testnet, EURC, 10 EURC per address every 24 hours).

```bash
npm run testnet:deploy -- --asset EURC:GB3Q6QDZYTHWT7E5PVS3W7FUT5GVAFC5KSZFFLPU25GO7VTC3NM2ZTVO --amount 2
# fund the buyer at faucet.circle.com, then:
npm run testnet:e2e
npm run testnet:e2e-claims
npm run testnet:refusals
```

Run 8 (29 Oct 2026) is this sequence on Circle's testnet EURC at 2 EURC per order; every tx is in [docs/testnet-proofs.md](../docs/testnet-proofs.md#run-8-real-circle-testnet-eurc-guard-v09-29-oct-2026-1156-to-1205-utc).

`--amount` sets the per-order amount (stored in `testnet-state.json`; every e2e script also takes `--amount`). Each script checks the buyer's balance before it signs anything. At 2 EURC per order:

| Script | Buyer must hold | Buyer spends for good |
|---|---|---|
| `testnet:e2e` | 4.4 EURC | 2 EURC (A released) |
| `testnet:e2e -- --silent-buyer` | 6.6 EURC | 4 EURC |
| `testnet:e2e-claims` | 4.4 EURC | 2 EURC (D paid to the seller) |
| `testnet:refusals` | 4.4 EURC | 2 EURC (A released) |

All three without `--silent-buyer` fit in one 10 EURC drip (6 EURC spent; e2e-claims already covers the silent-buyer flow). Refunds come back whole once the platform tops up the two fees. The platform needs no drip: each script releases an order before its first refund, so the platform's 4.7% fee covers the top-ups. If the platform ever holds less than a top-up, the top-up is skipped and logged rather than failing the run. With an external asset the buyer also sends 0.0001 to `third` once, the dust the stand-in deploy issues.

## Metric

```bash
npm run metric -- --footprint footprint.json --observations observations.json   # recorded or indexer export
npm run metric -- --footprint footprint.json --rpc <url> --start-ledger <n>     # live, read-only
```

The metric definition itself is `computeMetric` from `@motored-stellar/reconciler`. This script adds the footprint checks (token, and the guard as both signers) and the window, then maps chain data to that function's input.

The footprint lists the platform address, guard, registry, sponsor, token contract and escrow IDs. It also lists excluded escrows: test, team and related-party orders. The script counts a release, or a dispute resolved to the seller through the guard. Volume is the gross amount that leaves the escrow in the seller-paying transaction. The floor (PASS/FAIL) is EUR 4,000, 20 escrows, 12 buyer wallets and 4 sellers, inside a 45-day window; the target (EUR 7,000, 35 escrows, 20 wallets, 6 sellers) is reported, not a condition. Silent-buyer resolutions beyond half of the counted escrows are not counted. Exit code 0 means PASS and 3 means FAIL. See `docs/metric.md`.

RPC keeps only a short event history, so for a full window, read events from an indexer export (`--observations`). `--save-observations` records a live read.

## Re-check a claim

```bash
npm run claims:recheck -- --claim claim.json [--guard C...] [--rpc <url>]
npm run claims:recheck -- --claim claim.json --root <hex>     # offline, against a published root
```

The re-check recomputes the leaf from the claim's public fields. It walks the proof, then calls `registry.verify` (false for a revoked batch) and `anchored_at`. With `--guard`, it also checks that the batch was anchored after the escrow was first seen fully funded. A claim carries no parcel number and no salt.

## Ports

Where Motored's system would plug in, the scripts use small interfaces with mock implementations:

- `KeyStore`: `FileKeyStore` (`.keys/testnet.json`) and `InMemoryKeyStore`.
- `DeliveryOracle`: `MockDeliveryOracle` in `testnet/order-kit.ts`. It makes a synthetic parcel and event and contacts no carrier.
- `RegistryReader` and `GuardReader`: RPC and in-memory versions for the re-check.
- `EscrowStateReader` and `EventSource`: RPC versions for the metric. A recorded observation file stands in for an indexer.

## Tests

```bash
npm test
```

The unit tests cover only the parts that need no network:

- The network guard rejects the mainnet passphrase and mainnet RPC hosts.
- Keys are written only inside `.keys/` (0600, git-ignored), and no CLI output contains a secret.
- Claim leaf and tree encodings match, including an independent XDR byte layout.
- Re-checks pass for a valid claim and fail when the batch is revoked, the claim was anchored before funding, or a field is tampered with.
- The metric CLI gives the expected verdict over the recorded fixture in `test/fixtures/`. That fixture is synthetic and does not describe real activity.

Live testnet runs are manual and are not part of CI.

## Provenance

These scripts were ported from the architecture lab's testnet runs (`setup.sh`, `upload.mjs`, `arch.mjs`, `arch8.mjs`, `sim-anchor.mjs`) and its money-flow scripts. The lab loaded keys from the `stellar keys` CLI keystore. Here they come from a `KeyStore`, and contract IDs come from `testnet-state.json` instead of `*.txt` files.
