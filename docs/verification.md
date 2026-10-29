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

## Test runs of this repository

| Date | Where | Result |
|---|---|---|
| 27 Oct 2026 | Local (not CI) | `cargo test`: 76 passed (guard 68, claim registry 8); vitest: 382 passed across the workspaces; typecheck clean; the in-memory example ran |
| 29 Oct 2026 | Local (not CI) | vitest: 388 passed across the workspaces (adds the run-5 helpers and the depth-32 proof builder); docs lint clean; scripts typecheck clean |
| | GitHub Actions | The link to the first CI run is added here after the first push |

## Unit tests against Trustless Work's deployed Wasm

| Guard version | Result | Notes |
|---|---|---|
| v0.6 | 30 passed, 0 failed | Both Trustless Work Wasm lineages |
| v0.7 | 52 passed, 0 failed | 25 lineage tests x 2 Wasm files + `m01` + `m02` |
| v0.8 | 66 passed, 0 failed | 32 lineage tests (`t01`-`t25`, `x01`-`x07`) x 2 Wasm files + `m01` + `m02` |

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
