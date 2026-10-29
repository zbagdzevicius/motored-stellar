# Verification log

What has been proven, how, and where to look. All on-chain evidence below is on **Stellar
testnet** (contract IDs and transaction hashes are public; look them up on
[stellar.expert](https://stellar.expert/explorer/testnet) or Horizon testnet). Testnet resets
erase these links; after a reset, re-run `npm run testnet:deploy` and `npm run example -- --testnet`
and append the new run below and to [testnet-proofs.md](testnet-proofs.md), which lists every ID with a stellar.expert link.

The lab runs in this file were made with the lab prototype of the guard (crate `lab-guard`) before
it moved into this repository as `motored-escrow-guard`. The code is the same v0.8 logic. The first
run from this repository's own scripts is run 4, 28 Oct 2026, with every contract ID and tx hash in
[testnet-proofs.md](testnet-proofs.md#run-4-guard-v08-from-this-repositorys-scripts-28-oct-2026-0937-to-0939-utc).
Run 5, 28 Oct 2026, 22:08 to 22:11 UTC, used the same deployment for the silent-buyer payout
against a delivery claim with a 32-level proof (seller resolution 4,955,849 CPU instructions in
enforce-mode simulation) and the buyer contest followed by a full refund; every tx is in
[testnet-proofs.md](testnet-proofs.md#run-5-silent-buyer-and-buyer-contest-from-this-repositorys-scripts-28-oct-2026-2208-to-2211-utc).
Run 7, 29 Oct 2026, 09:27 to 09:35 UTC, deployed guard v0.9 (v0.8 rules plus in-contract TTL
upkeep, optimised Wasm sha256 `f53d1ece92fcc29f822aac45a720f4b112a0cdd637e22bf3185cc1ae23c4d0d1`) and
re-ran the run 4 and run 5 scenarios on it; the extended TTLs were read back from the ledger
([testnet-proofs.md](testnet-proofs.md#run-7-guard-v09-with-ttl-upkeep-29-oct-2026-0927-to-0935-utc)).
Run 8, 29 Oct 2026, 11:56 to 12:05 UTC, was the first on Circle's testnet EURC (issuer
`GB3Q6QDZYTHWT7E5PVS3W7FUT5GVAFC5KSZFFLPU25GO7VTC3NM2ZTVO`, SAC
`CCUUDM434BMZMYWYDITHFXHDMIVTGGD6T2I5UKNX5BSLXLW7HVR4MCGZ`) instead of a stand-in asset: a fresh
deployment of guard v0.9 (uploaded Wasm `c3fe2055...`, the workspace 0.9.0 build), scenarios A to E
with 2 EURC orders and four refusals landed as failed transactions
([testnet-proofs.md](testnet-proofs.md#run-8-real-circle-testnet-eurc-guard-v09-29-oct-2026-1156-to-1205-utc)).
Run 9, 29 Oct 2026, 19:03 to 19:10 UTC, deployed guard v0.10 (optimised Wasm sha256
`2a21ef35e57f8505861296e2b93a09c5aa2117c66a5fb5d3d2cbcefe3087fbb5`, 22,664 bytes, platform fee cap
500 bps) and a fresh claim registry (`e829dc52...`) on Circle's testnet EURC and landed a
buyer-approved release, the v0.10 seller-only `withdraw_remaining_funds` payout past a buyer with no
trustline and 1 unit of dust, and an over-cap `register_escrow` as a failed transaction
(`PlatformFeeOverCap` = 29)
([testnet-proofs.md](testnet-proofs.md#run-9-guard-v010-on-circle-testnet-eurc-29-oct-2026-1903-to-1910-utc)).

## Test runs of this repository

| Date | Where | Result |
|---|---|---|
| 27 Oct 2026 | Local (not CI) | `cargo test`: 76 passed (guard 68, claim registry 8); vitest: 382 passed across the workspaces; typecheck clean; the in-memory example ran |
| 29 Oct 2026 | Local (not CI) | vitest: 388 passed across the workspaces (adds the run-5 helpers and the depth-32 proof builder); docs lint clean; scripts typecheck clean |
| 29 Oct 2026 | GitHub Actions | First run on push of the published history, 29 Oct 2026: all four jobs green (contracts, TypeScript on Node 20 and 22, secrets and lint): https://github.com/zbagdzevicius/motored-stellar/actions/runs/40831236550 . Every later push runs the same workflow: https://github.com/zbagdzevicius/motored-stellar/actions |
| 29 Oct 2026 | GitHub Actions | Run at tag `pre-award-filing` as first set, before guard v0.9, all four jobs green (contracts, TypeScript on Node 22 and 24, secrets and lint): `cargo test` 76 passed (guard 68, claim registry 8); vitest 393 passed across the eight workspaces, identical on Node 22 and 24: https://github.com/zbagdzevicius/motored-stellar/actions/runs/40839759344 . |
| 29 Oct 2026 | Local (not CI), guard v0.9 | `cargo test`: 83 passed (guard 75: 73 rule and TTL tests plus 2 leaf golden-vector tests; claim registry 8); vitest: 396 passed across the eight workspaces (adds the metric collector paging tests); typecheck clean; docs lint clean; `check-secrets` OK; `stellar contract build` and `optimize`: guard v0.9 `f53d1ece...` |
| 29 Oct 2026 | Local (not CI), repo finalize, version 0.9.0 | `cargo test`: 83 passed (guard 75, claim registry 8); vitest: 410 passed across the eight workspaces (claims 35, escrow 73, eurc 67, ramps 56, reconciler 55, wallets 61, scripts 55, example 8; adds the CAP-71 V2 auth-entry tests in `packages/escrow` and `packages/wallets`, the V2 fee-bump refusals in `packages/eurc` and the getTransfers paging tests in `packages/reconciler`); typecheck clean; docs lint clean; `check-secrets` OK; `stellar contract build` and `optimize` at workspace version 0.9.0: guard `c3fe2055...` (see the note under Guard v0.9 below). The README quotes this row. |
| 29 Oct 2026 | GitHub Actions, run 8 commit | All four jobs green; vitest 413 (adds the --asset, decimal-amount and faucet-drip tests in scripts): https://github.com/zbagdzevicius/motored-stellar/actions/runs/40872318292 |
| 29 Oct 2026 | GitHub Actions, v0.9 commits | All four jobs green (contracts, TypeScript on Node 22 and 24, secrets and lint): https://github.com/zbagdzevicius/motored-stellar/actions/runs/40855043032 |
| 29 Oct 2026 | Local (not CI), architecture audit fixes, version 0.10.0 | `cargo test --locked -- --test-threads=1`: 95 passed (guard 84: 82 rule and TTL tests plus 2 leaf golden-vector tests; claim registry 11); `stellar contract build` passes; vitest: 445 passed across the eight workspaces (claims 42, escrow 89, eurc 67, ramps 56, reconciler 58, wallets 61, scripts 64, example 8; adds the event-reader paging and RPC-limit tests, the submitter retry, idempotency and mempool-eviction resend tests in all three submitters, the revoked-key upkeep test and the funded-in-window metric tests); typecheck and docs lint clean. Guard v0.10 was not yet deployed on testnet then (runs 7 and 8 ran v0.9; run 9 deployed v0.10 with the fee cap) |
| 29 Oct 2026 | Local (not CI), silent-buyer cap raised from one half to two thirds | vitest: 448 passed across the eight workspaces (claims 42, escrow 89, eurc 67, ramps 56, reconciler 60, wallets 61, scripts 65, example 8; adds the two-thirds cap, the two-per-approval and the 7-of-20 floor tests in the reconciler and the two-thirds footprint test in scripts); typecheck and docs lint clean. Rust counts unchanged (95) |
| 29 Oct 2026 | Local (not CI), guard v0.10 platform fee cap | `cargo test --locked -- --test-threads=1`: 99 passed (guard 88: 86 rule and TTL tests, adding `x15`-`x16` on both Trustless Work lineages, plus 2 leaf golden-vector tests; claim registry 11); `stellar contract build` passes; vitest: 453 passed across the eight workspaces (claims 42, escrow 89, eurc 67, ramps 56, reconciler 60, wallets 61, scripts 69, example 9; adds the `max_platform_fee_bps` Cfg, flag-parsing, fee-cap probe and run budget tests in scripts and the fee-cap mirror test in the example); typecheck and docs lint clean |
| 29 Oct 2026 | Testnet, run 9 on Circle testnet EURC, guard v0.10 `CCRZHNU2...J2KVUZ` | `testnet:e2e` (A release after buyer approval, seller received 1.9 EURC, claim re-check ok; B dispute refund and C break-glass refund, each buyer netting 100% after the top-up) and `testnet:v010` (F1 `register_escrow` of an escrow at 501 bps landed as FAILED with `Error(Contract, #29) PlatformFeeOverCap`, confirmed from the ledger; F2 at 500 bps registered; W seller paid 1.9 EURC alone through `withdraw_remaining_funds` against a claim, past a buyer account with no EURC trustline and 1 unit of dust that stays in the escrow, registration closed, a second seller withdrawal refused with `Closed` = 17 in simulation). Links in [testnet-proofs.md, Run 9](testnet-proofs.md#run-9-guard-v010-on-circle-testnet-eurc-29-oct-2026-1903-to-1910-utc) |
| 29 Oct 2026 | Local (not CI), shipping outside the escrow, 1,000 bps mainnet cap | No contract change (`cargo test` not re-run: 99 stands). vitest: 462 passed across the eight workspaces (claims 42, escrow 97, eurc 68, ramps 56, reconciler 60, wallets 61, scripts 69, example 9; adds in `packages/escrow` the shipping-to-platform split (`orderAmountsCents`, `EscrowQuote.shippingToPlatform`), the guard-cap option on `quoteEscrow`, the worst-case test (5% commission plus a buyer fee of at most 5% quotes 922 bps; every cart whose items each cost over EUR 1.10 stays at or under 1,000) and `buildFundingTransactions` / `buildShippingPaymentTransaction` (a classic EURC payment to the escrow's pinned platform address, sequenced right after `fund_escrow`); in `packages/eurc` the sponsored shipping payment to `platformAddress`; the example pays shipping to the platform in the funding step); typecheck clean; docs lint clean |
| 29 Oct 2026 | Testnet, run 8 on Circle testnet EURC, guard v0.9 `CAYLUEO3...RRXNQC` | `testnet:e2e` (A release, B dispute refund, C break-glass refund), `testnet:e2e-claims` (D silent-buyer payout against a depth-32 claim, E buyer contest then refund) and `testnet:refusals` (`BadFeeAddr` = 15, `NoClaim` = 8, `NotWholeToBuyer` = 13, `Contested` = 25 landed as FAILED, each code confirmed from the ledger) all passed with 2 EURC orders; the seller received 1.9 EURC in e2e A and in D, every refunded buyer netted 100% after the top-up. `npm run claims:recheck -- --from-state` afterwards: `ok: true` for D (depth 32) and, with `--index 0`, for A. Links in [testnet-proofs.md, Run 8](testnet-proofs.md#run-8-real-circle-testnet-eurc-guard-v09-29-oct-2026-1156-to-1205-utc) |
| 29 Oct 2026 | Testnet, `npm run metric` | Run against the real escrows of runs 4 to 6 and of run 7: VERDICT FAIL (exit 3) on both, as expected for test volumes (300.0000000 over 3 escrows; 200.0000000 over 2 escrows); see [Re-run over runs 4 to 7](#re-run-over-runs-4-to-7-29-oct-2026-after-run-7) |

Tag `pre-award-filing` marks the code at filing: the commit the tag pre-award-filing points to (see `git show pre-award-filing`).
Commits after the tag change documentation, code comments, the Dependabot config and the published run logs in
[`docs/runs/`](runs/) only; no contract, package or script logic changes
(`git diff pre-award-filing -- contracts packages scripts` shows comment and README lines only).
That held until the guard v0.9 change set of 29 Oct 2026 (run 7), which changes logic in three
places: the guard contract (in-contract TTL upkeep, no rule change, new tests `x08`-`x10` and
`m03`), `scripts/lib/soroban.ts` (signs the V2 address credentials testnet RPC now returns) and
`scripts/metric/collect.ts` (event paging past short pages, new tests in
`scripts/test/collect.test.ts`). The repo finalize of the same day adds three package logic changes:
`packages/escrow/src/guard-auth.ts` and `packages/wallets/src/raw-signature.ts` sign the V2 (CAP-71)
address credentials as well as the legacy ones, keeping the variant they arrive in; and
`packages/reconciler/src/adapters/rpc.ts` pages `getTransfers` past short pages with the same rule
as the metric collector. The fee-bump policy in `packages/eurc` is unchanged: it sponsors only calls
whose auth entries all use source-account credentials, so it refuses V2 address entries exactly as it
refuses legacy ones (new tests). Other package changes in the set are comments only (resolved or
deliverable-tagged `TODO(verify)` markers).

The architecture audit fixes of 29 Oct 2026 (version 0.10.0, on testnet since run 9) change logic in:
the guard (`withdraw_remaining_funds` may pay the seller under the same rules as a resolution,
capped at the escrow amount and once, so a buyer who removes their trustline and dusts the escrow
cannot block the seller; TTL values raised to 120 / 150 days, at or above mainnet's minimum; new
tests `x11`-`x14` and `m04`); the claim registry (the same TTL values; `revoke`, `verify` and
`anchored_at` extend the entries they touch; three new tests); `packages/escrow` (event reader inside
RPC `getEvents` limits, submitter retries and idempotency); `packages/claims` (keeper upkeep of
`Revoked` keys); `packages/reconciler/src/metric.ts` and `scripts/metric` (escrows funded in the
45-day window count if they close within 14 days after it); `scripts/metric/collect.ts` (refuses a
start ledger outside RPC retention). The guard's platform fee cap of the same day adds one more
logic change: `Cfg::max_platform_fee_bps` (set at construction, 500 in run 9, 1,000 planned for mainnet), checked in
`check_escrow` and `register_escrow` with the new error `PlatformFeeOverCap` = 29 (tests `x15`-`x16`);
`scripts/testnet/deploy.ts` passes it (`--max-platform-fee-bps`, default 500),
`scripts/lib/soroban.ts` gains `landFailingCall` and `scripts/testnet/v010.ts` is the run 9 script.

## On-chain metric, dry run on testnet (29 Oct 2026)

`npm run metric` (scripts/metric) read live testnet RPC from ledger 5431300 for a footprint of the five
run 4-5 escrows: A (buyer-approved release), B (dispute refund), C (partial funding, break-glass
refund), D (silent-buyer seller payout against an anchored claim) and E (buyer contest, then refund);
guard `CBYWR2P3...Y467EX`, registry `CD27AQMH...3EYHPZ`, token the XEUR SAC `CDDP3WON...YOY4VF`
(the lab stand-in for EURC). Footprint and the saved observations:
[`runs/metric-footprint-runs-4-5.json`](runs/metric-footprint-runs-4-5.json),
[`runs/metric-observations-runs-4-5.json`](runs/metric-observations-runs-4-5.json).

```
network: testnet
window: 2026-10-28T09:37:45.000Z .. 2026-12-12T09:37:45.000Z (45 days)
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

FAIL is expected for five test escrows. The counting is the point: the release (A) and the
silent-buyer resolution (D) count at their gross 100 units each; the three refunds (B, C, E) are
ignored; every escrow passes the footprint checks (token, platform, guard as both signers). The SAC
transfer events decoded with the four-topic shape the collector expects. These are test escrows
and would be listed as excluded in the registered mainnet footprint.

### Re-run over runs 4 to 7 (29 Oct 2026, after run 7)

`npm run metric` against live testnet RPC, one footprint per deployment (a footprint names one
guard, and run 7 deployed a new one): runs 4 to 6 (guard `CBYWR2P3...Y467EX`, nine escrows: the
five above plus run 6's A, B, C, E) and run 7 (guard v0.9 `CBNODLOP...AJKX6`, six escrows: A to E
and the aborted A0). Footprints, saved observations and the captured output:
[`runs/metric-footprint-runs-4-6.json`](runs/metric-footprint-runs-4-6.json),
[`runs/metric-observations-runs-4-6.json`](runs/metric-observations-runs-4-6.json),
[`runs/metric-output-runs-4-6.txt`](runs/metric-output-runs-4-6.txt),
[`runs/metric-footprint-run-7.json`](runs/metric-footprint-run-7.json),
[`runs/metric-observations-run-7.json`](runs/metric-observations-run-7.json),
[`runs/metric-output-run-7.txt`](runs/metric-output-run-7.txt).
These captured outputs predate the change of the silent-buyer cap from one half to two thirds
(29 Oct 2026, later the same day); each footprint has one silent-buyer resolution against at least
one buyer-approved release, so it counts under either cap and the totals are unchanged.

| Footprint | Counted (volume) | Refunds ignored | Not counted | Verdict |
|---|---|---|---|---|
| Runs 4 to 6 | 3 escrows, 300 XEUR: run 4 A (release), run 5 D (silent buyer), run 6 A (release) | 6 | none | FAIL (exit 3), expected on testnet volumes |
| Run 7 | 2 escrows, 200 XEUR: A (release), D (silent buyer) | 3 | A0 (funded and approved, never settled) | FAIL (exit 3), expected on testnet volumes |

Both runs report 1 distinct buyer and 1 distinct seller (one key set) and 0 escrows dropped by the
footprint checks. The first attempt at the runs 4 to 6 footprint reported run 6's four escrows as
"never funded": the collector stopped paging at the first page shorter than its limit, but the RPC
scans a bounded ledger range per request (the first page from ledger 5431300 held 23 transfers and
ended near ledger 5441300; run 6 is at ledgers 5446746 and later). `scripts/metric/collect.ts`
now pages until the cursor stops moving or reaches the RPC's latest ledger (unit test
`scripts/test/collect.test.ts`), and the output above is from the fixed collector. The dry run
above (runs 4 and 5 only) was not affected: all its transfers were on the first page.

## Unit tests against Trustless Work's deployed Wasm

| Guard version | Result | Notes |
|---|---|---|
| v0.6 | 30 passed, 0 failed | Both Trustless Work Wasm lineages |
| v0.7 | 52 passed, 0 failed | 25 lineage tests x 2 Wasm files + `m01` + `m02` |
| v0.8 | 66 passed, 0 failed | 32 lineage tests (`t01`-`t25`, `x01`-`x07`) x 2 Wasm files + `m01` + `m02` |
| v0.9 | 73 passed, 0 failed (29 Oct 2026, local) | 35 lineage tests (adds `x08`-`x10`, TTL upkeep) x 2 Wasm files + `m01` + `m02` + `m03` (TTL upkeep on the built Wasm); plus the 2 leaf golden-vector tests, 75 in the guard crate |
| v0.10 | 86 passed, 0 failed (29 Oct 2026, local) | 41 lineage tests (adds `x11`, mainnet-sized TTL; `x12`-`x14`, the seller payout through `withdraw_remaining_funds` with a buyer that has no trustline; `x15`-`x16`, the platform fee cap) x 2 Wasm files + `m01`-`m04` (`m04`: the built Wasm on a mainnet-sized ledger); plus the 2 leaf golden-vector tests, 88 in the guard crate; claim registry 11. Before the fee cap: 82 (84 in the crate) |

Trustless Work Wasm: testnet `7c3f7b2af92ad86092708b23babf80f9e1308d7f3ce18b703b9499192ecc934b`,
mainnet `96d51751f924c938a081deb740056dc1c5cc60c6e645672062531f82957ed2fe`
(`contracts/third_party/tw-wasm/SHA256SUMS`). Toolchain: Rust 1.93.0, soroban-sdk 26.0.0.

Key results:

- Release split on both lineages: seller 950000000, platform 47000000, Trustless Work 3000000 (of
  1000000000 units), at a platform fee of 470 bps.
- Break-glass refund of a 40% funded escrow: 380000000 of 400000000 to the buyer (net of both fees).
- Look-alike escrow refused with `BadWasm` (#12); wrong token with `BadToken` (#11).
- `m01`: on the mainnet Wasm, release and break-glass with no fee-account trustline fail with the
  SAC's `Error(Contract, #13)` (trustline missing); the refund succeeds once the trustline exists.
- `m02`: guard compiled to Wasm, depth-32 seller resolution: 4,522,226 CPU instructions (testnet
  Wasm), 4,448,737 (mainnet Wasm).
- Guard v0.8 Wasm sha256 `6fb8e25dc3cba23bd3764cc6b4389982a956357e55b21b2a3a32ba527cebce77`
  (wasm-opt build that was deployed).
- v0.9 (this repository, 29 Oct 2026): `x08`-`x10` age the ledger until the guard's entries are
  under `TTL_THRESHOLD` and check that `register_escrow`, `contest`, an authorized `release_funds`
  and `withdraw_remaining_funds` set the registration and the instance to exactly `TTL_EXTEND_TO`
  (1,036,800 ledgers), that a refused authorization leaves both unchanged, and that the
  `registration` view does not extend; `m03` checks the same on the built Wasm. `m02` with v0.9:
  4,264,041 CPU instructions (testnet Wasm), 4,188,204 (mainnet Wasm). Guard v0.9 optimised Wasm
  sha256 `f53d1ece92fcc29f822aac45a720f4b112a0cdd637e22bf3185cc1ae23c4d0d1` (deployed in run 7).
- Workspace version 0.9.0 (repo finalize, 29 Oct 2026): run 7's Wasm was built with the workspace
  version still at 0.8.0. The version bump changes no source line, but it changes the guard's built
  bytes: with the same source, a clean `stellar contract build` plus `stellar contract optimize`
  gives `f53d1ece...` at 0.8.0 and
  `c3fe20557bcde3bea44b1cb74aa01efab00a46f52b3bd0ddb6f4c4c0f872fb22` (22,541 bytes) at 0.9.0
  (stellar CLI 23.4.0, rustc 1.93.0). The claim registry's optimised Wasm is unchanged
  (`af18affa...`). The run 7 hash refers to the deployed build; a fresh deployment from this
  repository uploads `c3fe2055...` (once optimised).
- v0.10 (this repository, 29 Oct 2026, deployed in run 9): `TTL_THRESHOLD` 2,073,600 ledgers (120
  days, mainnet's `min_persistent_ttl`) and `TTL_EXTEND_TO` 2,592,000 (150 days) in the guard and
  the claim registry; v0.9's 518,400 / 1,036,800 sat below the mainnet minimum, so its upkeep would
  have done nothing on mainnet for an entry's first 90 days. `x11` and `m04` check that the
  constructor and the first registration extend at once on a mainnet-sized ledger. `x12`-`x14`: with
  a buyer account that has no EURC trustline and 1 unit of dust in the escrow, a resolution with a
  buyer leg reverts ("trustline entry is missing for account"), while the seller's share is paid
  alone through `withdraw_remaining_funds` on the claim and approval paths, refused above the
  amount (#28), without a claim (#8), inside the contest window (#10) and a second time (#17).
  `x15`: an escrow at one basis point over `max_platform_fee_bps` (and one at 9,900) fails
  `check_escrow` and `register_escrow` with `PlatformFeeOverCap` (#29), and, funded anyway, every
  release or resolution through the guard fails `NotRegistered` (#1); `x16`: an escrow exactly at
  the cap registers and its release pays the platform exactly 5%. Guard v0.10 optimised Wasm sha256
  `2a21ef35e57f8505861296e2b93a09c5aa2117c66a5fb5d3d2cbcefe3087fbb5` (22,664 bytes, workspace
  version 0.10.0, stellar CLI 23.4.0, rustc 1.93.0), deployed in run 9; claim registry v0.10
  `e829dc52672dbc8aebca65c6595416ca2b8fba5b787a575e4a487dda3d808870` (4,161 bytes).

## Testnet run 1 (guard v0.6, 24 Oct 2026)

Guard `CCPWF7OW3KSTK2MK3HSQLWSTZ4W4K2F2SBJP7X6ZO3QMLQDJ4FA3B2UL`, registry
`CBMJ3HNYWEIIELFRTHEYG275IKK3JYKSXGPDGDSICGAZLTE6EXMA76QE`, lab asset SAC
`CBLO4JEJCBQBYSIUN3WVC2XPOW2NOFJPCQPQJ7MCZBHFHK4BXIPVPMT2`, uninitialised Trustless Work
testnet-Wasm instance used as deployer `CCRHYKGG6FBM7F74LH7QIYDM6OP3SSZ5FFHDDL6DTAUDX7JIM76N7C76`.
A lab asset stood in for EURC; the seller-payout delay was 120 s instead of 7 days.

| Step | Tx | fee_charged (stroops) |
|---|---|---|
| Atomic deploy and initialise through the Trustless Work deployer | `78fb5abd5f0aa7744d21ad9f0065c2a71f560fa2ee3acb5a5bb8de66ffc573f7` | 13,313,438 |
| Buyer `fund_escrow` | `c90787bf07f0004ec3b29e2bd976883080eced834577c34c251c9283e8a5bcfb` | 10,830,314 |
| `register_escrow` | `e4301f3c013ca0b37bf445bfeebafcae3779da6a474b71beeb5b453c7f7174ae` | |
| Buyer approve | `c29147668a4f1dc17d5cf9b52109f00a8a80c47f7c58710b823069981083acd7` | |
| Guarded `release_funds` (2,771,397 instructions) | `1db534873a2782f8e73eed638a73c816cbeaaea69a64279047ef4591f12e96e1` | 22,545 |
| Seller resolution with a depth-32 claim (4,942,420 instructions) | `14121ebaad1f6ae4ecd5839ba1c2aff84e8cc613cd97615ec406a244a7ced569` | 30,191 |
| Register at 40% funding | `7f05e4ef0535a506455ce12617c4a11794751c53c7dbf79df6378ce77d98ccf4` | |
| Break-glass refund to the buyer | `825f698624922a90b1df5032d02f379e05e7fe7d6c2f53068928342a069be109` | 25,482 |
| Revoke batch | `4aad4baab68503689f8a7055b7b6e359f9e0d5fee282ae03da9e79d95fe31082` | |
| Resolver refund to the buyer | `ae7f6756a3697584dd3b718482b889409fedf46236be55cf93957a2043f0b4bd` | |

Refused paths, recorded by enforce-mode simulation (not landed on-chain):

- by the guard: wrong fee address #15 (release and seller resolution); wrong key in the release
  branch (`Auth, InvalidAction`); third-address resolution #9; seller without a claim #8; partial
  withdraw to the seller during a dispute #9; seller before the delay #10; break-glass to the seller
  #13; claim anchored before registration #16; `verify` on a revoked batch returns false;
- by the Trustless Work contract: release before approval; register before funding (guard
  `NotFunded` #3); break-glass before any dispute (`EscrowNotInDispute`).

## Testnet run 2 (guard v0.7, 24 Oct 2026)

Guard `CDKARO3LJKPL7K5BJ6V3SO6OWTVLRQJDVNNIXCJ5BUIPZCPVEOCQ3IWK`, registry
`CDSD7V42YXRKL24QC7TCV5XBGWIO7RDXLXC32BA5ZLOTFCJNZHVSWDKV`, SAC
`CBYLCEFNLCMRRXFVODN2M444HQKASLJHYW6PZZITQVXLN774YMYXJSQS`, deployer
`CDJRR7UEJ5QYSSVIC3RP5OVA7SIMJRLEFUZOTP3P3FNVRUD4XMARYM7U`. Delay and contest window 120 s.

| Step | Tx | fee_charged (stroops) |
|---|---|---|
| Escrow naming another platform deployed (precheck then refuses #22) | `b595050442f4efabe275ca449fb3c014b6aaff76e70e77017b3b061b6a4c73d4` | 22,146,934 |
| Third-party 1-unit transfer to the unfunded escrow (precheck then refuses #24) | `9ea846f643e065c34fc56fed873dd79f40b9f4487753dfd75b27d3ebdebe9332` | 18,011,432 |
| Buyer funding with the pre-dust snapshot still lands | `0cc7af15ef853feccc087b41837c62ca0ee41ca3a34b5daea3186838a480ea76` | 12,003 |
| Platform dispute cancels a dusted escrow (buyer's pre-built funding then fails) | `1c5652293d63b6db3381c1a795238d2d284538fda43dd79a9dab693e7d596bdc` | 6,587 |
| Seller dispute after buyer approval | `465baee4e6c81ba969a33137526c090eae7ceec672e62fc631d8c8845f198f60` | 6,587 |
| Buyer contest | `82c18aa74596f17ea520ece62c7169f2f760287216b57c5005c26da53ec1c9a5` | 154,357 |
| Uncontested seller payout after the window, no claim (2,936,581 instructions) | `31c776b87527a73016451370c857910b8d23fcad4d7bedc82d36661696240202` | 27,133 |
| Refund to the buyer after the contest | `aaaf6aea235f5e8c4c2fd6c1ec25c4de677b0458336a74724908422e7e8687da` | 27,139 |

Refused by enforce-mode simulation: claim anchored before full funding #16; claimless payout
before approval and dispute were recorded #8; inside the window #10; after a contest #25; a contest
without the buyer's auth (`Auth, InvalidAction`).

## Testnet run 3 (guard v0.8, 24 Oct 2026)

Guard `CAM3KPYP6KOBSU4XMCHW46ARCGTVUOKM44YHHLQ7OXDAP23RBVSTN5NK`, registry
`CBDKYDECWAFVOGGDXWBSFSKPTZGWIENC7VBZG2LSFUQ3LJL3GSYYLV5W`, SAC
`CAOVNXTNKWGZV6PQNYQEO55J7LLEBIJKOXWWPDK54A6GI6DGROQFPKOS`, deployer
`CDBVSUBXPODDWLZVAGZAFZ6PTQTQ7Y7WWJX6A3BJOKHZRVPWXBXH7OME`. Contest window 120 s.

| Step | Tx | fee_charged (stroops) |
|---|---|---|
| Guard v0.8 deployed | `1ac5c84bab7cc90f06a5ab4305938d7a01e60bf84e35327343f01ce11fd5cb47` | 18,491,474 |
| O1 buyer funds the amount | `38987ef82ed1ec5559e3110d8edbbf413d670291d0bf1bab6372e9f6d78fe337` | 21,137,881 |
| O1 buyer funds again (balance 2x) | `25400724fa305a7e95ac12d0bdc85008e82163d871bd3d8bfb9a8ce318aed596` | 12,004 |
| O1 buyer approves | `501799539753bfb93e2c3b4da60b4abc4b9135e8eb03600d145637fed0395869` | 6,654 |
| O1 seller disputes | `65d904f85d15ebcaf66f8f8aa46d022710d4752873addf122bb68353c6848543` | 6,587 |
| O1 honest split after the window: seller the amount, buyer the excess (3,176,291 instructions) | `65701f3b210fe13a74234931cf7e8344bb900729bcb9410e53442d80d2b5df62` | 30,897 |
| C1 buyer contests first (approved, no dispute yet) | `5693488fee3429e53333ae1f9de2514618bd1691bbc8e8eeecba65a98d847598` | 181,123 |
| C1 buyer disputes second | `883b1dabd5b0406a598b0cbeab7b133a83d2427438f4a9d2edd59c89e505fb5a` | 6,586 |
| C1 refund to the buyer | `db5f64588de796639ec87c051ba46309728d0607dc72a6f1941c1b652eeed2dd` | 27,671 |

Refused by enforce-mode simulation after the window: O1 `{seller: 2x}` and
`{seller: amount+1, buyer: amount-1}` with `Error(Contract, #28)`; C1 claimless seller payout with
`Error(Contract, #25)`. O1 result: seller +950000000 (the release's net), buyer +950000000 (the
excess, less both fees, which the platform tops up as for any refund).

## Registry TTL cost (testnet)

Simulated `anchor` with a 30-day instance and root extension: minimum resource fee 5,573,839,684
stroops; rebuilt with a 2-day extension: 2,341,904. So the anchoring job extends in short steps.
Testnet settings at the time: `tx_max_instructions` 400,000,000; minimum persistent TTL 120,960
ledgers (about 7 days); `max_entry_ttl` 3,110,400.

## Source and network facts checked

| Fact | Checked against |
|---|---|
| Fee address is an argument on `7c3f7b2a`, not on `96d51751` | `stellar contract info interface` on both Wasm files, sha256 of both |
| Mainnet Wasm hardcodes the fee account | The only G-address in the `96d51751` binary |
| Fee account `GBWWSOAT...KSZN` has no EURC trustline | Horizon mainnet, read only, 24 Oct 2026 |
| Both fees floored on `escrow.amount`; resolutions pro rata per recipient | `calculator.rs`, `distribution.rs`, `escrow.rs` at `6e4d40e` |
| Funded escrow frozen except unapproved milestone appends | `validators/escrow.rs` |
| Withdraw works while merely disputed, partial, no event | `core/dispute.rs`, `validators/dispute.rs`, `events/handler.rs` |
| Empty milestone status can never be changed or approved | `validators/milestone.rs` |
| No upgrade entry point in either v1 Wasm | Both deployed interfaces |
| A muxed (M-) address cannot be passed as an `Address` role | soroban-env-host 26 `conversion.rs` |
| EURC flags (`auth_required` false, `auth_revocable` true, `auth_immutable` false, `auth_clawback_enabled` false) | Horizon mainnet asset |
| Testnet EURC not revocable; testnet USDC revocable | Horizon testnet |
