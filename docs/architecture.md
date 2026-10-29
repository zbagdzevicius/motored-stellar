# Architecture

Version 0.10 of the design (guard v0.10: v0.9 rules plus a seller dispute payout that no buyer leg can block, and mainnet-sized TTL upkeep; v0.9 added in-contract TTL upkeep to v0.8). Testnet only. This document describes an EURC payment
rail for a marketplace that already takes cards: the buyer pays in Circle EURC on Stellar, the
money sits in a non-custodial Trustless Work escrow until the buyer confirms receipt or, if the
buyer stays silent, until 7 days after a recorded carrier delivery.

Every protocol claim below was checked against the Trustless Work v1 source (branch
`single-release-main`, commit `6e4d40e`), against the escrow Wasm files Trustless Work has
deployed (testnet `7c3f7b2a...`, mainnet `96d51751...`), against live Horizon, and by running the
guard against those Wasm files locally and on testnet. Evidence: [verification.md](verification.md).

Contents: [1. Components](#1-components) · [2. Roles per escrow](#2-roles-per-escrow) ·
[3. Sequence](#3-sequence) · [4. Contract interfaces](#4-contract-interfaces) ·
[5. Keys](#5-keys) · [6. Money and ledger](#6-money-and-ledger) ·
[7. Failure modes](#7-failure-modes)

## 1. Components

### On Stellar (mainnet and testnet run Protocol 29)

- **Trustless Work escrow** (single-release, v1). One escrow per EURC order. Trustless Work runs
  two v1 lineages, and the guard handles both:
  - **testnet** Wasm `7c3f7b2a...` takes Trustless Work's fee address as an argument of
    `release_funds`, `resolve_dispute` and `withdraw_remaining_funds`;
  - **mainnet** Wasm `96d51751...` (branch `single-release-main`) hardcodes the fee account
    `GBWWSOATPLIC72ZBOIM7WJCT7VCAHNWW4QUBZ2H4FORMCCIUM5ZVKSZN`.

  The escrow holds EURC through the Stellar Asset Contract; as a contract address it needs no
  trustline. Once its balance is above zero its roles, amount, fee, trustline and existing
  milestones cannot change (`EscrowPropertiesMismatch`); the platform role can still append new,
  unapproved milestones, which blocks release until a dispute is resolved. A milestone whose
  status is empty can never be changed or approved, so every field is final before the escrow's
  address is shown to the buyer. Anyone can send EURC to the escrow address, and any balance, even
  1 unit, freezes `update_escrow`.
- **Guard contract** ([`contracts/guard`](../contracts/guard)). One Soroban account contract per
  network, set as both the escrow's `release_signer` and its `dispute_resolver`. Pinned at deploy
  time to one Trustless Work Wasm hash, the EURC Stellar Asset Contract, the platform (fee)
  address and, on the testnet lineage, Trustless Work's fee address. Its `__check_auth` has three
  branches with separate keys: release, resolution, and a refund-only break-glass. A read-only
  `check_escrow` confirms an escrow before any funding call is handed out. A buyer-signed
  `contest` lets the buyer switch off the one seller payout path that needs no delivery claim.
- **Claim registry** ([`contracts/claim-registry`](../contracts/claim-registry)). Write-once
  Merkle roots of delivery claims, each stored with the ledger timestamp of its anchor. The
  issuer key is separate from the release key; a separate offline revoker key can revoke a batch,
  after which none of its claims verify. Interface: `verify(batch_id, leaf, proof, index) -> bool`,
  `anchored_at(batch_id) -> u64`, `revoke(batch_id)`. SHA-256 nodes, proof depth at most 32.
- **EURC.** Mainnet issuer `GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2` (Circle),
  SAC `CDTKPWPLOURQA2SGTKTUQOWRCBZEORB4BWBOMJ3D3ZTQQSGE5F6JBQLV` (reference only; this repository
  deploys to testnet). Testnet EURC:
  `EURC-GB3Q6QDZYTHWT7E5PVS3W7FUT5GVAFC5KSZFFLPU25GO7VTC3NM2ZTVO`. `auth_required=false`, so a
  new (also a sponsored) trustline is authorised at creation. Circle can freeze balances
  (`auth_revocable=true` on mainnet; contract balances through the SAC admin). Clawback is not
  enabled today, but the issuer flags are not immutable. Testnet EURC is not revocable, so freeze
  behaviour is tested with testnet USDC or a lab asset.
- **User wallets.** Embedded wallets (Privy) are ordinary G-accounts owned by the user alone: no
  app authorisation key, no additional signers, no server-side export. The user signs each
  transaction hash in the browser; before signing, the UI decodes the transaction and shows the
  escrow ID, amount and asset. Users with their own wallet connect through Stellar Wallets Kit;
  every buyer or seller call uses the wallet as the transaction source, so only
  `signTransaction` is needed.
- **Platform accounts.** A fee account (the escrow's `platform` role: receives platform fees,
  opens platform disputes, edits unfunded escrows, sends refund top-ups) and a sponsor/submitter
  account (pays reserves and fees, submits transactions). The release, resolver, break-glass,
  registry-issuer, registry-revoker and guard-admin keys are signing keys and hold no funds.

### Off-chain (in this repository, behind ports)

| Component | Package | Port it needs from the marketplace |
|---|---|---|
| Escrow adapter: create, precheck, funding call, event reading | `packages/escrow` | `OrderSource`, `EscrowApi`, `Submitter`, `EventSource` |
| Fee, cap and rounding rules | `packages/escrow` | none (pure) |
| Release service: release, resolutions, withdrawals, refund top-ups | `packages/escrow` | `Signer` (guard keys), `Submitter`, `Clock` |
| Sponsor service: sponsored accounts, EURC trustlines, fee-bumps | `packages/eurc` | `Signer` (sponsor), `Submitter` |
| Wallets: embedded and connected | `packages/wallets` | `WalletProvider` |
| Ramps: on-ramp and off-ramp | `packages/ramps` | `RampProvider` |
| Claim batching and anchoring | `packages/claims` | `DeliveryOracle`, `Signer` (issuer) |
| Reconciliation and reports | `packages/reconciler` | `LedgerSource`, `EventSource`, `ReportSink` |

The adapter creates escrows through the Trustless Work v1 API, or through Trustless Work's
on-chain deployer entry point (`tw_new_single_release_escrow`), deploying and initialising in one
transaction, because `initialize_escrow` itself needs no authorisation. Before it hands a buyer
the funding call it runs `guard.check_escrow` by simulation and re-reads `get_escrow`, matching
amount, platform fee, approver, receiver, service provider and receiver memo against the order
(the guard does not check these). The buyer's `fund_escrow` carries that state as
`expected_escrow`, so the buyer's signature commits to the roles and flags. An order is paid only
when the buyer's own `fund_escrow` (signer = the order's buyer wallet) has brought the balance to
at least the escrow amount; a third party's transfer never marks it paid, and delivery claims are
issued only for paid orders.

## 2. Roles per escrow

| Trustless Work role | Holder | Why |
|---|---|---|
| approver | Buyer wallet | The buyer confirms receipt by approving the milestone. |
| service_provider | Seller wallet | Can change the milestone status and open a dispute; cannot move funds. |
| receiver | Seller's own wallet | Never a ramp deposit address: the v1 escrow pays a plain address, does not apply its `receiver_memo`, and its `Address` roles cannot hold a muxed (M-) address. |
| platform | Platform fee account (pinned in the guard per network) | Receives the platform fee; opens disputes; edits escrow properties only while unfunded; while funded can only append unapproved milestones, which can only block release. |
| release_signer | Guard contract | Signs a release only with the release key. Trustless Work itself requires the buyer's approval and no open dispute, and pays only the fixed receiver. |
| dispute_resolver | Guard contract | Pays only that escrow's buyer, or its seller against a verified claim anchored after full funding and at least 7 days old, or (buyer approved every milestone and a dispute is open, in either order) 7 days after both were recorded unless the buyer contested. Never more than the escrow amount to the seller. The resolver key holder may be a licensed third party. |

v1 roles are single addresses. The guard decodes v1 escrows only (decoding a v2 escrow fails,
tested), so moving to Trustless Work v2 needs a new guard build for new escrows.

EURC eligibility (v1 policy, enforced by the marketplace): single-seller carts; a carrier label
minted by the platform, so the parcel goes to the order's delivery address; a destination where
the carrier's authenticated tracking has already reported a delivery; a platform fee between 0
and 9,900 basis points (Trustless Work's cap).

## 3. Sequence

```mermaid
sequenceDiagram
  autonumber
  actor B as Buyer wallet
  participant P as Platform backend
  participant SP as Sponsor/submitter
  participant TW as Trustless Work API
  participant E as Escrow (one per order)
  participant G as Guard
  participant R as Claim registry
  participant C as Carrier tracking
  actor S as Seller wallet

  B->>P: Checkout (eligible order), choose EURC
  SP->>B: Sponsored account + EURC trustline if missing (user co-signs)
  P->>TW: Deploy escrow (roles, amount, platform fee bps, milestone)
  TW-->>P: Unsigned XDR, signed and submitted by SP
  P->>E: Every field final now (update_escrow if a status is empty)
  P->>G: check_escrow(E) by simulation; re-read get_escrow
  P->>B: fund_escrow XDR for exactly the amount, with expected_escrow
  B->>E: fund_escrow (EURC via SAC), fee-bumped by SP
  P->>G: register_escrow(E) (stores buyer, seller, amount; funded_at once balance >= amount)
  C-->>P: Delivered (the order's one parcel)
  P->>R: anchor(batch_id, root) incl. this escrow's claim; registry stores anchor time
  alt Buyer confirms receipt
    B->>E: approve milestone
    SP->>E: release_funds(G[, TW fee address on testnet])
    E->>G: __check_auth (release branch: release key)
    E->>S: amount - 0.3% TW fee - platform fee
  else Buyer silent 7 days after the claim was anchored
    P->>E: dispute (platform role)
    SP->>E: resolve_dispute({seller: amount, buyer: any excess}) authorised by G
    E->>G: __check_auth (claim verifies; anchored after funded_at; now >= anchored_at + 7 days)
  else Buyer approved, then a dispute blocks release (either order)
    opt Buyer contests within 7 days
      B->>G: contest(E, evidence hash)
    end
    SP->>E: resolve_dispute({seller: amount, buyer: any excess}) 7 days after both recorded, no contest
  else Refund before release
    SP->>E: resolve_dispute({buyer: balance}) authorised by G
    E->>B: balance less both fees
    P->>B: Top-up from the platform fee account, so the buyer receives 100%
  end
```

## 4. Contract interfaces

### Trustless Work escrow (v1 single-release)

Source: `github.com/Trustless-Work/trustlesswork-smart-contract-stellar`, branch
`single-release-main`, commit `6e4d40e`. Deployed Wasm: testnet
`7c3f7b2af92ad86092708b23babf80f9e1308d7f3ce18b703b9499192ecc934b`, mainnet
`96d51751f924c938a081deb740056dc1c5cc60c6e645672062531f82957ed2fe`.

| Call | Mainnet Wasm `96d51751` | Testnet Wasm `7c3f7b2a` |
|---|---|---|
| release | `release_funds(release_signer)` | `release_funds(release_signer, trustless_work_address)` |
| resolve | `resolve_dispute(dispute_resolver, distributions)` | `resolve_dispute(dispute_resolver, trustless_work_address, distributions)` |
| withdraw | `withdraw_remaining_funds(dispute_resolver, distributions)` | `withdraw_remaining_funds(dispute_resolver, trustless_work_address, distributions)` |

On the testnet lineage nothing in the escrow checks `trustless_work_address`, so the guard pins it.

Behaviour relied on, from source and tested against both deployed Wasm files:

- `release_funds` checks the signer is `roles.release_signer`, every milestone is approved and no
  dispute is open, then calls `release_signer.require_auth()`. It needs balance >= `amount`, pays
  fees on `amount` and the rest only to the fixed receiver. Any excess stays in the escrow.
- Fees: `TRUSTLESS_WORK_FEE_BPS = 30` plus `platform_fee` (at most 9,900 bps), both floored on
  the same base; each recipient's net is the remainder. Every exit transfers both fees first, in
  the same invocation (each only when above zero): if a fee account cannot receive EURC, the whole
  call reverts.
- `resolve_dispute` requires an open dispute and a distribution map (up to 50 addresses) that sums
  exactly to the live balance; every recipient has both fees deducted pro rata. No deadline, no
  auto-refund.
- `withdraw_remaining_funds` runs when the escrow is released, resolved **or merely disputed**,
  pays any total up to the balance, needs no map that sums to the balance, and emits no Trustless
  Work event. The guard lets it pay the buyer at any time and the seller only under the same
  seller rules as a resolution, once (v0.10).
- `fund_escrow(signer, expected_escrow, amount)` accepts any positive amount from any signer, any
  number of times, and fails if `expected_escrow` differs from the stored escrow.
- Any role except the dispute resolver can open a dispute; the escrow stores only a `disputed`
  flag, not who opened it. A dispute cannot be withdrawn; only a resolution clears it.
- `approve_milestone` and `change_milestone_status` fail with `EmptyMilestoneStatus` on an empty
  status.
- `initialize_escrow` needs no authorisation, so deployment must initialise in the same
  transaction. The deployer deploys whatever Wasm hash it is given, so the guard checks the
  escrow's Wasm hash itself. Neither deployed v1 Wasm has an upgrade entry point.

### Guard contract

```rust
struct Cfg { admin: Address,            // offline; proposes key changes, applied after a 7-day timelock
             resolver_admin: Address,   // the resolver-key holder; rotates the resolver key at once
             release_pk, resolver_pk, breakglass_pk: BytesN<32>,
             registry: Address, token: Address /* EURC SAC */,
             platform: Address,         // platform fee account, the escrow's `platform` role
             tw_wasm: BytesN<32>,       // pinned Trustless Work Wasm hash for this network
             tw_fee: Option<Address>,   // Some(a) on the testnet lineage: argument 1 must equal a
             delay: u64, rotate_delay: u64, contest_window: u64 /* 7 days each */ }

struct Reg { buyer: Address, seller: Address, amount: i128,
             registered_at: u64,          // first seen with balance > 0
             funded_at: Option<u64>,      // first seen with balance >= amount
             approved_at: Option<u64>,    // first seen with every milestone approved
             disputed_at: Option<u64>,    // first seen with the dispute flag set
             contested_at: Option<u64>,   // buyer-signed contest()
             closed: bool }

fn check_escrow(env, escrow) -> Result<(), Error>;      // read-only precheck, by simulation
fn register_escrow(env, escrow) -> Result<Reg, Error>;  // permissionless register-or-refresh
fn contest(env, escrow, evidence: BytesN<32>);          // buyer auth
fn propose_keys(env, release, resolver, breakglass);    // admin auth; applies after rotate_delay
fn apply_keys(env);                                     // anyone, after the timelock
fn rotate_resolver(env, resolver: BytesN<32>);          // resolver_admin auth

enum GuardSig { Release(BytesN<64>), Resolve(BytesN<64>),
                ResolveSeller { sig: BytesN<64>, claim: Claim }, BreakGlass(BytesN<64>) }
struct Claim { order_ref, parcels_commit, carrier_event_ref: BytesN<32>, delivered_at: u64,
               batch_id: u64, proof: Vec<BytesN<32>>, index: u32 }

fn __check_auth(env, payload: Hash<32>, sig: GuardSig, ctx: Vec<Context>) -> Result<(), Error>;
//   ctx must be exactly one Contract context on a registered escrow E; the variant selects the key.
//   BREAK-GLASS: resolve_dispute; breakglass key; the map has exactly one key, E.buyer.
//   RELEASE:     release_funds; release key; E not closed.
//   RESOLVE:     resolve_dispute or withdraw_remaining_funds; resolver key;
//     every recipient in {E.buyer, E.seller}; seller share <= E.amount (#28);
//     withdraw paying E.buyer alone: allowed at any time, closes nothing;
//     otherwise E not closed (#17), and a seller share needs E.funded_at and either
//       ResolveSeller: registry.verify(...) AND anchored_at > funded_at AND now >= anchored_at + delay, or
//       Resolve: approved_at and disputed_at set, no contest, now >= max(both) + contest_window.
//   A release, a resolution or a seller withdrawal closes E: the seller is paid at most once, never
//   more than E.amount; only withdrawals to the buyer remain.
```

**Seller payout no buyer can block (v0.10).** `resolve_dispute` needs a map that sums to the live
balance. A buyer who removes their own EURC trustline (only the account owner can sign
ChangeTrust, so the platform cannot restore it) and then sends 1 unit to the escrow forces a buyer
leg into every resolution, and that leg reverts; a Circle freeze of the buyer has the same effect.
`withdraw_remaining_funds` has no sum rule, so v0.10 lets the resolver pay the seller's share
through it alone, under the same claim or approval rules, at most the escrow amount and only once;
the remainder stays in the escrow for a later withdrawal to the buyer. Tests `x12`-`x14` (both
Trustless Work lineages) cover it with a buyer account that has no trustline.

The leaf is built inside the guard and bound to the escrow address, so a claim for one escrow
never pays another. Encodings: [leaf-format.md](leaf-format.md). The signature covers Soroban's
authorisation payload (network, nonce, invocation and arguments), so it cannot be replayed. The
guard never calls back into the escrow during `__check_auth` (Soroban forbids re-entry), which is
why buyer and seller are read at registration. The 7-day wait uses the registry's stored anchor
time, which the platform cannot backdate. The guard has no upgrade path: a new version is a new
contract used only for new escrows.

**TTL upkeep (v0.9; mainnet-sized in v0.10).** The guard keeps its own state alive. `register_escrow`, `contest` and
`__check_auth` extend the touched registration (`Reg`, persistent) and the guard's instance and
code; `propose_keys`, `apply_keys`, `rotate_resolver` and the constructor extend the instance and
code. Each extension is `extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO)`: an entry with 120 days
(2,073,600 ledgers at 17,280 a day) or less left is extended to 150 days (2,592,000 ledgers); above
that it is a no-op. The threshold equals mainnet's minimum persistent TTL (120 days; testnet's is
120,960 ledgers, 7 days), so a fresh entry is extended at its first touch on either network.
v0.9 used 30 and 60 days (518,400 / 1,036,800 ledgers), which run 7 read back on testnet but which
would do nothing on mainnet for an entry's first 90 days; every new mainnet entry already starts
with about 120 days of rent, paid at creation. The longest stretch the rules need without a touch is `delay` +
`contest_window` (7 + 7 days), and `register_escrow` is permissionless, so anyone can top a
registration up. The read-only views (`check_escrow`, `registration`) do not extend: they run by
simulation, where an extension never reaches the ledger. A refused authorization fails the
transaction, extension included. The upkeep changes no rule and writes no stored value. The claim
registry v0.10 extends its instance, and the root or revocation it reads, with the same values;
the escrows, the registry's `Revoked` entries and the Trustless Work Wasm code are still extended by
the anchoring job (an archived revocation makes `verify` fail closed until it is restored). Tests
`x08`-`x11` (both Trustless Work lineages) and `m03`-`m04` (built Wasm; `x11` and `m04` on a
mainnet-sized ledger) check it, and run 7 on testnet (v0.9 values) read the result back from the ledger
([testnet-proofs.md](testnet-proofs.md#run-7-guard-v09-with-ttl-upkeep-29-oct-2026-0927-to-0935-utc)).

**Third-party dust.** Registration needs only a balance above zero, so dust can register an
escrow before the buyer pays. It gains nothing: every seller payout needs `funded_at` (balance at
least the amount) and a claim anchored after it. The precheck refuses any escrow with a balance.
The guard refuses any resolution that gives the seller more than the escrow amount (#28), so dust
or overfunding can go only to the buyer.

**Seller dispute after buyer approval.** A Trustless Work dispute is final, so a seller could block
a release the buyer already approved. The guard therefore has a second seller path that needs no
claim: the buyer approved every milestone, a dispute is open (either order), and `contest_window`
has passed since both were recorded without a buyer `contest`. Because the escrow does not record
who opened a dispute, a buyer who wants to dispute an approved order submits `register_escrow`
(if needed), then `contest`, then `dispute_escrow`, as separate transactions.

## 5. Keys

See [trust-model.md](trust-model.md) for the full table of keys, what each can and cannot do, and
the plain-language trust statement.

## 6. Money and ledger

All amounts are in 7-decimal units (1 EURC = 10,000,000 units).

- **Escrow amount.** The order's items plus shipping plus any buyer fee, as charged.
- **Target.** The seller nets in EURC at least what the card rail pays for the same order
  (`card_net`), and at most 1 basis point of the escrow amount more.
- **Platform fee.** `platform_fee_bps = floor((9970 * amount - 10000 * card_net) / amount)`.
  Trustless Work's 0.3% comes out of the platform's share. EURC is offered only when the result is
  between 0 and 9,900. Trustless Work's floors can add at most 1 unit per fee per recipient in the
  recipient's favour; it is logged on its own reconciliation line.
- **Refunds before release.** A resolution to the buyer returns the balance minus the 0.3% and the
  platform fee. The platform then sends the buyer a top-up of exactly those two amounts from its fee
  account, so the buyer receives 100%. The platform's net cost per refunded escrow is the 0.3%.
- **Cancellation before funding.** The platform submits an `update_escrow` that changes a field
  Trustless Work freezes once funded (the title). That succeeds only while the balance is 0 and
  invalidates the buyer's funding call. If it fails because of third-party dust, the platform opens
  a dispute instead, which also invalidates the buyer's pre-built funding call.
- **Partial funding.** Never marks the order paid; unwound by a platform dispute and a resolution
  (or break-glass) of the whole balance to the buyer, with fees topped up.
- **Refunds after release.** The escrow is empty; post-release refunds are off-chain.
- **Reconciliation.** A scheduled task checks each open escrow's balance, flags and outgoing EURC
  transfers, and each refund top-up, against the order ledger, to the cent
  ([`packages/reconciler`](../packages/reconciler)).
- **Measurement footprint.** Platform address, guard contract ID, registry ID, sponsor account,
  the EURC asset, and escrow contract IDs as they are created. See [metric.md](metric.md).

## 7. Failure modes

| Failure | Effect | Handling |
|---|---|---|
| Trustless Work's mainnet fee account cannot receive EURC (no EURC trustline on `GBWWSOAT...KSZN`, checked on Horizon 24 Oct 2026) | Every exit of a mainnet EURC escrow reverts, break-glass included (tested against the mainnet Wasm) | Mainnet gate: no mainnet EURC escrow until Horizon shows an authorised EURC trustline on that fee account |
| Platform fee account cannot receive EURC | Same: every exit reverts | Monitor the trustline; restore it |
| Buyer never approves | Funds stay in escrow | 7 days after the claim is anchored, the platform opens a dispute; the guard resolves to the seller only against that claim |
| No carrier "delivered" status | No claim, so no seller payout without the buyer's approval | Destinations enabled only after a confirmed delivery; otherwise refund |
| Guard defect in the release or resolution branch | Release or refund blocked | Break-glass branch (offline key, refund-only) refunds the whole balance of a disputed escrow to the buyer; per-order and total caps until audit |
| Escrow layout or Wasm differs from what the guard decodes | Registration fails | `check_escrow` by simulation before any funding call |
| Empty milestone status | The buyer can never approve | Precheck refuses it; every field final before the address is shown |
| Underfunded escrow | Release would revert | Order stays unpaid; refunded to the buyer through a platform dispute |
| Overfunded escrow, or third-party transfer | Excess stays after release | Resolutions rebuilt from the current balance; seller share capped (#28); after release `withdraw_remaining_funds` to the buyer (a seller share after release is refused, #17) |
| Seller (or a compromised platform key) disputes after the buyer approved | Release blocked | Approval path after the 7-day contest window, at the release's net, unless the buyer contested |
| Escrow names another platform address (compromised checkout) | Platform fee leg would go elsewhere | Precheck and registration refuse it (#22): the guard authorises no exit, funds stay locked rather than paid out |
| Platform appends a milestone to a funded escrow | Release blocked | Alert on any `update_escrow` of a registered escrow; recover by dispute and resolution |
| Seller has no EURC trustline | Payout to the seller reverts | Pre-flight trustline check before every release or resolution; a removed trustline is restored only with the seller's own signature (ChangeTrust), then sponsored again |
| Buyer removes their EURC trustline (or is frozen) and dusts the escrow | Every resolution has a reverting buyer leg | v0.10: the seller's share is paid alone through `withdraw_remaining_funds` (same rules, capped, once); the remainder waits for the buyer (tests `x12`-`x14`) |
| Circle freezes an account, the escrow, or a fee account | Transfers fail | Alert; dispute; wait for unfreeze, then refund from the escrow |
| v1 API rejects a contract address in a role | Guard cannot be set through the API | Deploy Trustless Work's same Wasm through its on-chain deployer (proven on testnet) |
| Depth-32 verify inside `__check_auth` exceeds budget | Seller resolution blocked | Measured about 4.5M instructions locally, 4.94M simulated on testnet, against a 400M limit |
| Claim not yet anchored | Seller resolution refused (by design) | Anchor on a schedule; alert on queued resolutions |
| Registry, guard, registration or escrow archived | Calls need a restore | The guard extends its instance and every registration it touches (v0.10: to 150 days once 120 or fewer remain, above mainnet's 120-day minimum; v0.9's 30/60 days would do nothing on mainnet), and the registry v0.10 its instance, roots and revocations; the anchoring job extends registry roots and revocations, escrows and Wasm code; restore is automatic since Protocol 23. Archival is a liveness issue only: a `Reg` is persistent storage, archived and restorable, never deleted and re-created |
| Release key leaked | Can co-sign releases | Still needs the buyer's approval; pays only the fixed seller; rotate through the timelock |
| Resolver key leaked | Can resolve disputes | Buyer or seller only, seller capped at the amount, seller needs a claim plus 7 days or uncontested approval; cannot open a dispute; rotate at once |
| Issuer key leaked; forged claims anchored | Seller payouts on disputed escrows after 7 days | Alert on every anchor; offline revoker revokes the batch within 7 days; the issuer is a multisig G-account whose leaked signer is removed at the account level; if the account must change, a new registry and guard serve new escrows while the revoker watches the old registry |
| RPC event gap | Missed state change | Store events beyond RPC retention; periodic full re-read of open escrows; `getEvents` kept inside RPC limits (5 contract IDs, 5 topic filters, start at the oldest retained ledger, page to the latest) |
| Transaction dropped, delayed or out of sequence | Payout not applied, or applied twice if blindly re-sent | Hash saved before sending and looked up before a re-send; `TRY_AGAIN_LATER` and `txBadSeq` (sequence still behind) re-sent; polling until a ledger closes after `maxTime`, then expired and rebuilt (`RpcSubmitter`, `packages/escrow`) |
| Testnet reset | Registry, guard and escrows wiped | `scripts/testnet/deploy.ts` redeploys; [verification.md](verification.md) keeps the tx record |
| Trustless Work v1 deprecated | Unplanned migration | New guard build with v2 types, for new escrows only |
