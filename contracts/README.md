# contracts

Soroban contracts for the EURC escrow flow. A Cargo workspace (soroban-sdk 26.0.0, Rust 1.93.0,
target `wasm32v1-none`).

| Crate | Path | What it does | SCF deliverable |
|---|---|---|---|
| `motored-escrow-guard` | [`guard/`](guard) | Custom account (`__check_auth`) that holds the Trustless Work v1 single-release `release_signer` and `dispute_resolver` roles and narrows them | D6 |
| `claim-registry` | [`claim-registry/`](claim-registry) | Write-once Merkle roots of delivery claims, with anchor time and revocation | D6 (on-chain part) |
| `fake-escrow` | [`test-fixtures/fake-escrow/`](test-fixtures/fake-escrow) | Look-alike escrow used only by the guard's negative tests. Never deploy | test fixture |
| Trustless Work Wasm | [`third_party/tw-wasm/`](third_party/tw-wasm) | `fetch.sh` downloads Trustless Work's deployed escrow Wasm by hash for the tests | test input |

A tagged release of this workspace is part of D13.

**Status: v0.10 (v0.9 plus a seller payout no buyer leg can block, a cap on the escrow's platform fee rate, and mainnet-sized TTL upkeep in the guard and the registry), unaudited, testnet only. Deployed on testnet in run 9 (29 Oct 2026, Circle testnet EURC; [proofs](../docs/testnet-proofs.md#run-9-guard-v010-on-circle-testnet-eurc-29-oct-2026-1903-to-1910-utc)).**

## Build and test

```bash
cd contracts
./third_party/tw-wasm/fetch.sh            # TW testnet 7c3f7b2a... and mainnet 96d51751..., sha256-checked
stellar contract build                    # or: cargo build --target wasm32v1-none --release
cargo test
```

The order matters. The guard tests:

* `contractimport!` the built `claim_registry.wasm` and `fake_escrow.wasm` from
  `target/wasm32v1-none/release/`,
* load the guard's own `motored_escrow_guard.wasm` (the metering test runs the guard as Wasm), and
* load both Trustless Work Wasm files from `third_party/tw-wasm/`.

`fetch.sh` needs `TW_MAINNET_RPC_URL` (any Stellar mainnet RPC endpoint) for the mainnet file. It
only reads the Wasm code entry; nothing in this repository deploys to mainnet. Set
`TW_WASM_SRC_DIR` to copy the two files from a local cache instead (still hash-checked).

Expected result: 99 tests. 86 guard tests in `guard/src/test.rs` (41 tests x 2 Trustless Work
lineages, plus `m01`-`m04`; v0.9 added the TTL upkeep tests `x08`-`x10` and `m03`; v0.10 added
`x11`-`x14` and `m04`, then the platform fee cap tests `x15` (one basis point over the cap, and
9,900 bps, refused at precheck and registration) and `x16` (exactly at the cap, registered and
released)), the 2 leaf golden-vector tests in `guard/src/test_vectors.rs` (the
same vectors are asserted by `packages/claims`), and 11 claim-registry tests. `cargo test -- --nocapture` prints the payout splits and the metered CPU
and memory cost of a seller resolution with a depth-32 proof (`m02`).

`test_snapshots/` directories written by soroban-sdk are git-ignored.

## The guard

Escrow model: the buyer funds a Trustless Work v1 single-release escrow in EURC. The escrow names
the guard as both `release_signer` and `dispute_resolver`, so every payout needs the guard's
`__check_auth` to accept a signature from one of three ed25519 keys, each limited to one branch:

| Branch (`GuardSig`) | Key | Allowed call | Rule |
|---|---|---|---|
| `Release` | release | `release_funds` | Trustless Work requires every milestone approved by the buyer and no open dispute |
| `Resolve` | resolver | `resolve_dispute`, `withdraw_remaining_funds` | Recipients only buyer and seller. Seller share only on the approved-and-uncontested path (buyer approved, dispute seen afterwards, no `contest` within `contest_window`). `withdraw_remaining_funds` to the buyer alone is allowed at any time |
| `ResolveSeller` | resolver | `resolve_dispute`, `withdraw_remaining_funds` | Seller share backed by a delivery claim anchored after full funding and at least `delay` old |
| `BreakGlass` | break-glass (offline) | `resolve_dispute` | Whole distribution to the buyer (refund only) |

TTL upkeep (v0.9): `register_escrow`, `contest` and `__check_auth` extend the touched registration
and the guard's instance and code; the key-rotation calls and the constructor extend the instance and
code. An entry with 120 days (`TTL_THRESHOLD`, 2,073,600 ledgers, mainnet's `min_persistent_ttl`) or
less left is extended to 150 days (`TTL_EXTEND_TO`, 2,592,000 ledgers), so a fresh entry is extended
at its first touch on mainnet as on testnet (v0.10; v0.9's 30/60 days left a fresh mainnet entry
untouched for 90 days). The views `check_escrow` and `registration` do not extend. No rule changes.

In every seller payout the seller's share is capped at the escrow amount (v0.8); overfunding and
dust can only go to the buyer.

Platform fee cap (v0.10): `check_escrow` and `register_escrow` refuse an escrow whose Trustless Work
`platform_fee` is above `Cfg::max_platform_fee_bps` (set per deploy (500 bps in run 9; 1,000 bps planned for mainnet; shipping is paid to the platform address in the funding step, outside the escrow; an order whose quote is above the cap stays on the card rail)) with
`PlatformFeeOverCap` (29). Trustless Work freezes the fee once the escrow holds a balance and the
guard registers only from that point, so no escrow the guard pays out of carries a higher rate; an
over-cap escrow is never registered, so every guard branch refuses it (`NotRegistered`). Before
v0.10 the guard pinned the platform fee account but not the rate.

Seller payout without a buyer leg (v0.10): `resolve_dispute` needs a map that sums to the escrow's
live balance, so a buyer who removes their EURC trustline (or whose account Circle freezes) and sends
1 unit of dust could make every seller resolution carry a buyer leg that reverts. The resolver
branches therefore also authorise `withdraw_remaining_funds` with a seller share, under the same
seller rules (claim, or approved and uncontested) and the same cap. Any authorised seller share,
on either entry point, closes the registration, so the seller is paid at most once and never more
than the escrow amount in total. The rest stays in the escrow for the buyer and leaves through
`withdraw_remaining_funds` to the buyer alone, which stays allowed after closing.

Public functions:

| Function | Auth | Purpose |
|---|---|---|
| `__constructor(cfg: Cfg)` | deployer | Fixes the configuration |
| `check_escrow(escrow)` | none (simulate) | Precheck before the buyer funds: pinned Wasm hash, guard in both roles, token, platform fee account, platform fee at or under `max_platform_fee_bps`, receiver = service provider, flags clear, milestone statuses set, zero balance |
| `register_escrow(escrow)` | none | Same pins and fee cap, then register at balance > 0 and record `funded_at`, `approved_at`, `disputed_at` once each from on-chain state |
| `registration(escrow)` | none | Read the recorded `Reg` |
| `contest(escrow, evidence)` | buyer | Switches off the approved-and-uncontested seller path for this escrow |
| `propose_keys(release, resolver, breakglass)` / `apply_keys()` | admin / none | Timelocked rotation of all three keys (`rotate_delay`) |
| `rotate_resolver(resolver)` | resolver_admin | Immediate resolver-key rotation |

`Cfg` is the integration surface: `admin`, `resolver_admin`, `release_pk`, `resolver_pk`,
`breakglass_pk`, `registry`, `token` (EURC SAC), `platform` (platform fee account),
`max_platform_fee_bps` (cap on the escrow's `platform_fee`, v0.10; 500 in run 9, 1,000 planned for mainnet), `tw_wasm`
(pinned Trustless Work Wasm hash), `tw_fee` (`Some(address)` for the testnet lineage whose release,
resolve and withdraw take `trustless_work_address` as argument 1; `None` for the mainnet lineage with
a hardcoded fee account), `delay`, `rotate_delay`, `contest_window` (seconds).

Error codes (`GErr`) are stable: 1 NotRegistered, 2 WrongRole, 3 NotFunded, 4 Changed,
5 BadContext, 6 BadFn, 8 NoClaim, 9 BadRecipient, 10 TooEarly, 11 BadToken, 12 BadWasm,
13 NotWholeToBuyer, 14 BadArgs, 15 BadFeeAddr, 16 ClaimPredatesEscrow, 17 Closed,
18 AlreadySettled, 19 NoPending, 20 Timelocked, 21 BadMilestone, 22 BadPlatform, 23 BadRoles,
24 NotEmpty, 25 Contested, 26 ContestTooLate, 27 NoDisputeSeen, 28 SellerOverAmount,
29 PlatformFeeOverCap (v0.10).

The `tw` module mirrors the Trustless Work v1 single-release storage types at upstream commit
`6e4d40e25057dc51fcffd9c5cbee05eaf369380a` so the guard can decode `get_escrow`. See
[`../NOTICE`](../NOTICE).

## The claim registry

| Function | Auth | Purpose |
|---|---|---|
| `__constructor(issuer, revoker)` | deployer | Online issuer key anchors; separate offline revoker key revokes |
| `anchor(batch_id, root)` | issuer | Write-once root; records the ledger timestamp |
| `anchored_at(batch_id)` | none | Anchor time; `Revoked` (6) or `NoRoot` (5) otherwise |
| `verify(batch_id, leaf, proof, index)` | none | Inclusion proof; nodes `sha256(0x02 \|\| left \|\| right)`, depth at most 32 (`ProofTooLong`, 4) |
| `revoke(batch_id)` | revoker | Permanent; emits `BatchRevoked` |

Delivery-claim leaf (tag `0x01`), computed on chain by `motored_escrow_guard::leaf`:

```
sha256(0x01 || XDR(ScVal::Address(escrow)) || order_ref || parcels_commit || carrier_event_ref || u64_be(delivered_at))
```

See [`../docs/leaf-format.md`](../docs/leaf-format.md).

TTL upkeep (v0.10): `anchor` extends the new root, `revoke` the revocation entry, and `verify` and
`anchored_at` the revocation entry or root they read; every call extends the instance and code. Same
values as the guard (120 / 150 days, at or above mainnet's minimum; v0.8's 1 / 2 days were below every
network's minimum, so its extensions were no-ops). An extension on a path that then fails is rolled
back with it, so the off-chain keeper still extends revocation entries. The issuer and revoker are
fixed at construction; they are meant to be multisig G-accounts that rotate signers at the account
level, and a compromised one is replaced by a new registry and a new guard for new escrows.

## Provenance

Ported from the architecture lab (guard v0.8, 66/66 tests passing there against the same
two Trustless Work Wasm hashes). Changes in the port: crate renames, the claim field
a carrier-specific claim field name replaced by `carrier_event_ref` (same 32 bytes, same leaf byte order),
platform-neutral comments, new claim-registry unit tests.

## TODO(verify)

Each item closes in D13 (open-source release).

* Trustless Work's license for its deployed Wasm, before ever committing the fetched files.
* `stellar contract fetch --wasm-hash` was checked against Stellar CLI 23.4.0; re-check with the CI
  pinned CLI version, and that both Wasm code entries are still live (not archived) on their networks.
* Final public repository URL in `Cargo.toml` (`workspace.package.repository`).
