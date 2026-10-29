# Threat model and monitoring plan

Scope: the guard contract, the claim registry, the escrow adapter and release service, the sponsor
service, wallets, ramps and reconciliation in this repository, used with Trustless Work v1
single-release escrows in EURC. Method: STRIDE per component, a LINDDUN-style privacy pass, and
an on-chain monitoring plan. Status column: **enforced** (contract code, with a test), **adapter**
(TypeScript in this repo, with a test), **operational** (a deployment practice this repo documents
but cannot enforce), **open** (not addressed yet).

Assets: escrowed EURC; the guard's signing keys; the registry's issuer and revoker keys; the
sponsor account's XLM; users' wallet keys (never held by the platform); order-to-wallet linkage.

## STRIDE

| # | Threat | Example | Mitigation | Status |
|---|---|---|---|---|
| S1 | Spoofed release | Attacker co-signs `release_funds` with a stolen release key | Trustless Work still requires the buyer's on-chain approval and no dispute; the release pays only the fixed receiver; rotate through the admin timelock | enforced |
| S2 | Spoofed resolution | Leaked resolver key resolves disputes | Recipients limited to {buyer, seller}; seller share <= amount (#28); seller needs a claim (anchored after full funding, 7 days old) or uncontested approval; the resolver key cannot open a dispute; `resolver_admin` rotates at once | enforced |
| S3 | Spoofed claim | Leaked issuer key anchors forged claims | Claims pay only after 7 days; alert on every anchor; offline revoker revokes the batch, after which `verify` returns false; the issuer is a multisig G-account, so the leaked signer is removed at the account level (master weight 0); if the account itself must change, a new registry and a new guard serve new escrows while the revoker watches the old registry until its escrows close | enforced (revoke) + operational (alert, rotation) |
| S4 | Spoofed contest | Seller submits `contest` to block the claimless path | `contest` requires the stored buyer's auth (Soroban auth error otherwise) | enforced |
| S5 | Look-alike escrow | Checkout points the buyer at a contract that is not Trustless Work's | Guard pins the Wasm hash (#12) and the EURC SAC (#11); the adapter refuses to issue a funding call unless `check_escrow` passes | enforced + adapter |
| T1 | Escrow edited before funding | Platform key changes the receiver after the buyer saw the address | The buyer's `fund_escrow` carries `expected_escrow`; any change makes the funding call fail | enforced (Trustless Work) |
| T2 | Milestone appended while funded | Bug or compromised platform key appends an unapproved milestone | Release blocked, funds cannot move elsewhere; alert on any `update_escrow` of a registered escrow; recover by dispute and resolution | operational |
| T3 | Wrong fee address | Testnet-lineage call passes another `trustless_work_address` | Guard pins it (#15) | enforced |
| T4 | Claim moved between escrows | A valid claim for escrow A used on escrow B | Leaf is built inside the guard from escrow B's address | enforced |
| T5 | Back-dated claim | Claim anchored before the buyer funded (for example after dust) | Seller path needs `anchored_at > funded_at` (#16) and the 7-day wait uses the registry's ledger time | enforced |
| T3b | Inflated platform fee rate | Compromised checkout or a backend bug creates an escrow whose `platform_fee` pays the platform far more than its rate (up to Trustless Work's 9,900 bps) | Guard v0.10 caps the rate: `check_escrow` and `register_escrow` refuse an escrow above `max_platform_fee_bps` (set per deploy (500 bps in run 9; 1,000 bps planned for mainnet; shipping is paid to the platform address in the funding step, outside the escrow; an order whose quote is above the cap stays on the card rail), fixed at construction) with #29; Trustless Work freezes the fee once funded and the guard registers only from then, so an over-cap escrow is never registered and no guard branch pays out of it (tests `x15`-`x16`, both lineages; landed as a failed `register_escrow` in run 9). Shipping is no longer in the escrow (the buyer pays it to the platform address in the funding step), so the fee carries only commission and buyer fee, about 922 bps at 5% each, and the planned mainnet cap is 1,000 (`MAINNET_MAX_PLATFORM_FEE_BPS`, `fees.test.ts`) | enforced |
| T7 | Misdirected or orphaned shipping payment | Compromised checkout sends the buyer's shipping payment elsewhere, or the shipping payment lands while `fund_escrow` does not | `buildFundingTransactions` pays only the escrow's `platform` role, which `check_escrow` has just matched to the pinned platform address; the wallet review screen shows the destination and amount before signing; the payment is the next transaction in the buyer's sequence after `fund_escrow`, so it cannot land before that sequence number is used; the order is paid only when both land, and a shipping payment without a funded escrow is refunded by the platform, as on the card rail; the sponsor fee-bumps a classic payment only to the configured platform address. The platform holds shipping directly (it buys the label), so shipping refunds rest on the platform, not on the guard | adapter + operational |
| T6 | Overfunding or dust paid to the seller | Resolver sends the whole balance of an overfunded escrow to the seller | Seller share capped at the amount (#28), on `resolve_dispute` and `withdraw_remaining_funds`; any seller payout closes the registration, so a second one is refused (#17) | enforced |
| R1 | Repudiated delivery | Buyer says the parcel never arrived after a silent-buyer payout | Claim is a public, write-once record with anchor time; the 7-day window is the dispute period; the carrier reference hash is kept off-chain for audits | operational |
| R2 | Unexplained transfer | EURC leaves an escrow with no matching record (`withdraw_remaining_funds` emits no Trustless Work event) | Event reader watches EURC transfers out of registered escrows; reconciler flags any unmatched transfer | adapter |
| I1 | Parcel number leak | Parcel number in a claim linked to public carrier tracking | `parcels_commit` is HMAC-SHA256 under a per-order secret salt | enforced (format) |
| I2 | Order linkage | Database IDs in escrow text fields | Random `order_ref`; escrow text fields random or generic | adapter |
| I3 | Blind signing | User signs a partner-built transaction that does something else | The UI decodes the XDR and shows escrow ID, amount and asset before signing | adapter |
| D1 | Fee account without EURC trustline | Every exit reverts, break-glass included | Mainnet gate; monitor the trustline on both fee accounts | operational |
| D2 | Circle freeze | Escrow balance or a fee account frozen | Alert on SAC `set_authorized` events; dispute and wait | operational |
| D3 | Archived entries | Registry root, guard registration or escrow instance archived | Guard v0.10 extends its own instance and code and each registration it reads (`register_escrow`, `contest`, `__check_auth`) to 150 days once 120 or fewer remain (at or above mainnet's 120-day minimum TTL; v0.9's 30/60 days would do nothing on mainnet); the claim registry v0.10 extends its instance and the root or revocation it reads the same way; the anchoring job extends registry roots and `Revoked` entries, escrow instances and Wasm code; alert near expiry; restore is automatic since Protocol 23. Liveness only: a registration is persistent storage, so archival never deletes it and cannot reset `closed` or the recorded timestamps | enforced (guard entries) + operational (the rest) |
| D4 | Sponsor drain | Attacker gets the sponsor to fee-bump arbitrary transactions | Fee-bump allowlist: single-operation transactions on the user's own order escrow, the buyer's `contest`, trustline operations, the seller's off-ramp payment, the buyer's shipping payment to the configured platform address; inner fee caps; per-wallet rate limits; re-simulate before signing | adapter |
| D5 | Seller griefing | Seller disputes after the buyer approved, to block release | Approval path pays the seller after the contest window at the release's net, or the buyer contests | enforced |
| D5b | Buyer griefing | Buyer removes their own EURC trustline (only the owner can sign ChangeTrust, so the platform cannot restore it), or is frozen by Circle, then sends 1 unit to the escrow: every `resolve_dispute` must sum to the balance, so it carries a buyer leg that reverts | Guard v0.10 pays the seller's share alone through `withdraw_remaining_funds` (no sum rule), under the same claim or approval rules, capped at the amount and only once; the remainder waits in the escrow for the buyer (tests `x12`-`x14`, both Trustless Work lineages; landed on testnet in Circle EURC in run 9) | enforced |
| D6 | Proof DoS | Huge proofs inside `__check_auth` | Depth capped at 32; measured 4.5M instructions against a 400M limit | enforced |
| D7 | RPC event gap | Missed funding or dispute event | Store events beyond retention; periodic full re-read of open escrows; `getEvents` kept inside RPC limits (escrows in groups of 5, topic filters split, start at the oldest retained ledger, page to the latest ledger) | adapter |
| D8 | Dropped or re-sent transaction | A payout is lost on `TRY_AGAIN_LATER` or `txBadSeq`, or paid twice by a blind re-send after a timeout | `RpcSubmitter` saves the hash before sending and looks it up before a re-send; re-sends `TRY_AGAIN_LATER` and `txBadSeq` while the sequence is behind; polls until a ledger closes after `maxTime` before reporting expiry; sends per source account are serialised by the caller | adapter + operational |
| E1 | Guard defect | Bug in the release or resolution branch | Refund-only break-glass branch with its own key and tests; per-order and total open-value caps until an external audit | enforced + operational |
| E2 | Runtime with several keys compromised | Attacker holds resolver + issuer + platform keys | Sellers of existing escrows only, after 7 days, revocable; separate service identities; offline revoker; alerts | operational |
| E3 | Compromised checkout | Escrows created with attacker roles or an inflated platform fee | Guard pins platform, fee address, fee rate cap and Wasm (#22, #23, #15, #29, #12); an escrow naming another platform, or a fee above the cap, is never registered, so its funds stay locked rather than paid out | enforced |
| E4 | Key rotation abuse | Admin swaps in attacker keys | Public `KeysProposed` event and a 7-day timelock before `apply_keys` | enforced |
| E5 | No in-contract rotation of fixed roles | Registry issuer and revoker, guard admin and resolver admin have no setter; the guard's registry pointer is fixed | Each is a multisig G-account whose signers rotate at the account level; replacing an account means a new registry and guard for new escrows | operational |

TTL notes (guard and registry v0.10). Values: `TTL_THRESHOLD` 2,073,600 ledgers (120 days, equal
to mainnet's `min_persistent_ttl`), `TTL_EXTEND_TO` 2,592,000 ledgers (150 days), at 17,280 ledgers
a day; v0.9 used 518,400 / 1,036,800 (30 / 60 days), below the mainnet minimum, so its upkeep would
have done nothing on mainnet for an entry's first 90 days. The host clamps a persistent extension
to the network maximum (testnet `maxEntryTtl` 3,110,400, read 29 Oct 2026). Every new mainnet entry
starts with about 120 days of rent, paid at creation. Extension adds rent to the transaction that
triggers it: in run 7 (v0.9, testnet) the first `register_escrow` of an escrow was charged 383,152
stroops against 50,416 in run 4 (v0.8, no extension), and the guard deployment, which extended its
22,541-byte code and instance to 60 days, was charged 106,688,213 stroops; mainnet figures are
measured at cutover. The
extension is not a security control: it never changes a decision, and a refused authorization
rolls it back.

Out of scope here: the marketplace's own web application security, the ramp provider's KYC,
and Trustless Work's API.

## Privacy (LINDDUN-style)

| Threat | Data | Mitigation |
|---|---|---|
| Linkability | Wallet address used across orders | Pseudonymous; users may use a fresh wallet; public reports are aggregates |
| Identifiability | Parcel number | Salted HMAC commitment only |
| Non-repudiation (user side) | Buyer's `contest` evidence | Only a 32-byte hash goes on-chain |
| Detectability | Order volume per day | Batches anchored on a fixed cadence |
| Disclosure | Escrow text fields | Random or generic values |
| Unawareness | Users unaware amounts are public | Checkout copy states it |

## Monitoring plan

Alerts read Soroban RPC `getEvents`, Horizon, and the reconciler output. Severity P1 pages an
operator; P2 is reviewed the same day.

| Alert | Source | Severity |
|---|---|---|
| EURC transfer out of a registered escrow with no matching release, resolution or withdrawal record | SAC transfer events | P1 |
| `update_escrow` on a registered escrow | Trustless Work events | P1 |
| Resolution without a dispute record in the platform's ledger | Trustless Work events + ledger | P1 |
| Every `anchor` and every `revoke` | Registry events | P2 (anchor), P1 (revoke) |
| `KeysProposed`, `KeysApplied`, `ResolverRotated` | Guard events | P1 |
| `BuyerContested` | Guard events | P2 |
| Fee-account EURC trustline missing or deauthorised (platform and Trustless Work) | Horizon | P1 |
| SAC `set_authorized(false)` touching the footprint | SAC events | P1 |
| Escrow stuck: funded, no movement for N days beyond the expected window | Reconciler | P2 |
| Failed release or resolution submission | Submitter | P2 |
| Reconciliation difference above 0 units (unexplained) | Reconciler | P1 |
| Entry TTL below threshold (registry, guard, registrations, open escrows, TW Wasm code) | RPC `getLedgerEntries` | P2 |
| Sponsor account balance below threshold | Horizon | P2 |
| New escrow naming the platform address with no matching order | Trustless Work `tw_init` events | P1 |
