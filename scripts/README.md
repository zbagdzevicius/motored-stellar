# @motored-stellar/scripts

Runnable command-line tools for the escrow rail: create testnet keys, deploy, run an end-to-end order, recompute the Tranche 3 on-chain metric, and re-check a delivery claim.

Deploy and e2e work on **testnet only**. Each one checks the network passphrase and RPC URL, then asks the RPC server which network it serves, and stops on anything other than testnet. The metric and re-check scripts are read-only. They can read mainnet through an explicit `--rpc`, but they never sign or submit anything.

| Script | What it does | SCF deliverable |
|---|---|---|
| `testnet/keys.ts` | Generates every role at runtime, saves it to `.keys/testnet.json` and funds the accounts through friendbot. Prints G-addresses and guard public keys only. | D13 testnet demo |
| `testnet/deploy.ts` | Sets up a stand-in XEUR issuer, trustlines and its SAC. Deploys the claim registry. Uploads the guard through a fee-bump and deploys it with `Cfg` pinned to Trustless Work testnet Wasm `7c3f7b2a...`. Deploys a Trustless Work deployer instance. Writes the resulting IDs to `testnet-state.json`. | D13 |
| `testnet/e2e.ts` | Runs orders on testnet: release with an anchored claim, dispute then refund plus top-up, and a partial-funding break-glass refund. `--silent-buyer` adds a claim-based seller payout. Prints stellar.expert links and exports the run log to `scripts/out/`. | D4 (public half), D13 |
| `testnet/e2e-claims.ts` | The two claim flows: a silent buyer whose seller is paid through dispute resolution against a delivery claim anchored with a 32-level Merkle proof (verified in the guard's `__check_auth`) after the payout delay, and a buyer contest on the guard that blocks the seller payout and ends in a full refund plus top-up. Waits out the 120 s windows once for both. Shared steps live in `testnet/order-kit.ts`. | D4 (public half), D6, D13 |
| `metric/index.ts` | Recomputes the Tranche 3 metric from a footprint file and prints PASS or FAIL. | D12 |
| `claims/recheck.ts` | Re-checks a released order's delivery claim against the registry, using the published leaf format. | D6 |

## Keys and secrets

- Keys are generated when you run `keys.ts`. Accounts get random ed25519 seeds. The release, resolver and break-glass guard keys get 32 random bytes each. The lab derived its guard keys from fixed seeds, which are public, so this repo does not use them.
- Key material is written only to `<repo>/.keys/testnet.json`, with mode 0600. The root `.gitignore` excludes `.keys/`, and the directory also holds its own `*` ignore file. `FileKeyStore` refuses any path outside that directory.
- Nothing prints a secret. Use `publicView()` for anything that reaches a terminal.
- `testnet-state.json` holds only public contract IDs and claims, and is git-ignored. Run logs in `scripts/out/` hold only public transaction hashes.

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
npm run claims:recheck -- --from-state
```

Set `MS_TESTNET_RPC` to use a different testnet RPC. The network guard still applies.

## Metric

```bash
npm run metric -- --footprint footprint.json --observations observations.json   # recorded or indexer export
npm run metric -- --footprint footprint.json --rpc <url> --start-ledger <n>     # live, read-only
```

The metric definition itself is `computeMetric` from `@motored-stellar/reconciler`. This script adds the footprint checks (token, and the guard as both signers) and the window, then maps chain data to that function's input.

The footprint lists the platform address, guard, registry, sponsor, token contract and escrow IDs. It also lists excluded escrows: test, team and related-party orders. The script counts a release, or a dispute resolved to the seller through the guard. Volume is the gross amount that leaves the escrow in the seller-paying transaction. The thresholds are EUR 7,000, 35 escrows, 20 buyer wallets and 6 sellers, inside a 45-day window. Silent-buyer resolutions beyond half of the counted escrows are not counted. Exit code 0 means PASS and 3 means FAIL. See `docs/metric.md`.

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
