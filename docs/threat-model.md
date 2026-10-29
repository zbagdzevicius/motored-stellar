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
| S3 | Spoofed claim | Leaked issuer key anchors forged claims | Claims pay only after 7 days; alert on every anchor; offline revoker revokes the batch, after which `verify` returns false | enforced (revoke) + operational (alert) |
| S4 | Spoofed contest | Seller submits `contest` to block the claimless path | `contest` requires the stored buyer's auth (Soroban auth error otherwise) | enforced |
| S5 | Look-alike escrow | Checkout points the buyer at a contract that is not Trustless Work's | Guard pins the Wasm hash (#12) and the EURC SAC (#11); the adapter refuses to issue a funding call unless `check_escrow` passes | enforced + adapter |
| T1 | Escrow edited before funding | Platform key changes the receiver after the buyer saw the address | The buyer's `fund_escrow` carries `expected_escrow`; any change makes the funding call fail | enforced (Trustless Work) |
| T2 | Milestone appended while funded | Bug or compromised platform key appends an unapproved milestone | Release blocked, funds cannot move elsewhere; alert on any `update_escrow` of a registered escrow; recover by dispute and resolution | operational |
| T3 | Wrong fee address | Testnet-lineage call passes another `trustless_work_address` | Guard pins it (#15) | enforced |
| T4 | Claim moved between escrows | A valid claim for escrow A used on escrow B | Leaf is built inside the guard from escrow B's address | enforced |
| T5 | Back-dated claim | Claim anchored before the buyer funded (for example after dust) | Seller path needs `anchored_at > funded_at` (#16) and the 7-day wait uses the registry's ledger time | enforced |
| T6 | Overfunding or dust paid to the seller | Resolver sends the whole balance of an overfunded escrow to the seller | Seller share capped at the amount (#28) | enforced |
| R1 | Repudiated delivery | Buyer says the parcel never arrived after a silent-buyer payout | Claim is a public, write-once record with anchor time; the 7-day window is the dispute period; the carrier reference hash is kept off-chain for audits | operational |
| R2 | Unexplained transfer | EURC leaves an escrow with no matching record (`withdraw_remaining_funds` emits no Trustless Work event) | Event reader watches EURC transfers out of registered escrows; reconciler flags any unmatched transfer | adapter |
| I1 | Parcel number leak | Parcel number in a claim linked to public carrier tracking | `parcels_commit` is HMAC-SHA256 under a per-order secret salt | enforced (format) |
| I2 | Order linkage | Database IDs in escrow text fields | Random `order_ref`; escrow text fields random or generic | adapter |
| I3 | Blind signing | User signs a partner-built transaction that does something else | The UI decodes the XDR and shows escrow ID, amount and asset before signing | adapter |
| D1 | Fee account without EURC trustline | Every exit reverts, break-glass included | Mainnet gate; monitor the trustline on both fee accounts | operational |
| D2 | Circle freeze | Escrow balance or a fee account frozen | Alert on SAC `set_authorized` events; dispute and wait | operational |
| D3 | Archived entries | Registry root, guard registration or escrow instance archived | Guard v0.9 extends its own instance and code and each registration it reads (`register_escrow`, `contest`, `__check_auth`) to 60 days once 30 or fewer remain; the anchoring job extends registry roots, escrow instances and Wasm code; alert near expiry; restore is automatic since Protocol 23. Liveness only: a registration is persistent storage, so archival never deletes it and cannot reset `closed` or the recorded timestamps | enforced (guard entries) + operational (the rest) |
| D4 | Sponsor drain | Attacker gets the sponsor to fee-bump arbitrary transactions | Fee-bump allowlist: single-operation transactions on the user's own order escrow, the buyer's `contest`, trustline operations, the seller's off-ramp payment; inner fee caps; per-wallet rate limits; re-simulate before signing | adapter |
| D5 | Seller griefing | Seller disputes after the buyer approved, to block release | Approval path pays the seller after the contest window at the release's net, or the buyer contests | enforced |
| D6 | Proof DoS | Huge proofs inside `__check_auth` | Depth capped at 32; measured 4.5M instructions against a 400M limit | enforced |
| D7 | RPC event gap | Missed funding or dispute event | Store events beyond retention; periodic full re-read of open escrows | adapter |
| E1 | Guard defect | Bug in the release or resolution branch | Refund-only break-glass branch with its own key and tests; per-order and total open-value caps until an external audit | enforced + operational |
| E2 | Runtime with several keys compromised | Attacker holds resolver + issuer + platform keys | Sellers of existing escrows only, after 7 days, revocable; separate service identities; offline revoker; alerts | operational |
| E3 | Compromised checkout | Escrows created with attacker roles | Guard pins platform, fee and Wasm (#22, #23); an escrow naming another platform is never registered, so its funds stay locked rather than paid out | enforced |
| E4 | Key rotation abuse | Admin swaps in attacker keys | Public `KeysProposed` event and a 7-day timelock before `apply_keys` | enforced |

TTL notes (guard v0.9). Values: `TTL_THRESHOLD` 518,400 ledgers (30 days), `TTL_EXTEND_TO`
1,036,800 ledgers (60 days), at 17,280 ledgers a day. The host clamps a persistent extension to
the network maximum (testnet `maxEntryTtl` 3,110,400, read 29 Oct 2026). Extension adds rent to
the transaction that triggers it: in run 7 the first `register_escrow` of an escrow was charged
383,152 stroops against 50,416 in run 4 (v0.8, no extension), and the guard deployment, which now
extends its 22,541-byte code and instance to 60 days, was charged 106,688,213 stroops. The
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
