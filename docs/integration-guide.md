# Integration guide: adding an EURC escrow rail beside a card checkout

Audience: a marketplace that already takes card payments and holds seller payouts until delivery,
and wants to add a second rail where the buyer pays in EURC on Stellar into a Trustless Work
escrow. Cards stay. Nothing in this guide replaces your card flow; EURC is an extra payment
option on orders that qualify.

This guide follows the design in [architecture.md](architecture.md) and the code in this
repository. Testnet only until you have an external audit of the guard and registry and your own
legal review of the roles you hold.

## 0. What you plug in

Every integration point is a typed port in [`packages/escrow/src/ports.ts`](../packages/escrow/src/ports.ts).
Implement these against your own system; the in-memory versions show the expected behaviour.

| Port | You provide | Used by |
|---|---|---|
| `OrderSource` | Order reference, buyer and seller G-addresses, escrow amount in 7-decimal units, the card-rail seller net (`card_net`) | escrow adapter, reconciler |
| `DeliveryOracle` | Delivered events from your carrier: a hash of the carrier event, the delivery time, and a salted commitment to the parcel number | claims |
| `Signer` | Signing for the platform's keys (transaction hashes, Soroban auth entries, raw ed25519 for the guard keys) | escrow, eurc, claims |
| `Submitter` | Send a signed transaction (and fee-bump it) through your RPC | all on-chain writes |
| `KeyStore` | Where keys live (your secret manager); testnet uses runtime-generated keys | scripts |
| `Clock` | Current time | release timing, tests |
| `EscrowApi` | Trustless Work REST client (API key) | escrow adapter |
| `RampProvider` | Bridge (KYC links, virtual accounts, liquidation addresses) | ramps |
| `WalletProvider` | Privy embedded wallets or Stellar Wallets Kit | wallets |
| `LedgerSource` | What your books expect: balances, refunds, top-ups per escrow | reconciler |
| `EventSource` | Soroban RPC `getEvents`, or your indexer for history beyond RPC retention | escrow event reader, reconciler, metric |
| `ReportSink` | Where reconciliation and metric reports go | reconciler |

Run [`examples/order-flow`](../examples/order-flow) first: it drives one order through every port
with in-memory implementations, so you can swap in your adapters one at a time.

Each package also declares the ports it needs locally, so every package builds on its own with no
workspace dependency. The shapes line up so one adapter object can serve several packages:

| Port | Shape | Declared in |
|---|---|---|
| `Signer` | `publicKey(): string`, `signTxHash(hash: Uint8Array): Promise<Uint8Array>` (escrow adds `rawPublicKey()` for guard keys) | escrow, claims, eurc |
| `Clock` (seconds) | `nowSeconds(): number`, Unix seconds, as the ledger and the guard count time | escrow, claims |
| `Clock` (milliseconds) | `now(): number`, epoch ms | eurc, reconciler |
| `Clock` (date) | `now(): Date` | ramps |
| `WalletProvider` | full wallet port (`getAddress`, `signTransaction`, `signAuthEntry`) in wallets; escrow keeps a minimal `walletFor(userRef): Signer` for the example | wallets, escrow |
| `RampProvider` | full Bridge-shaped port in ramps; escrow keeps a minimal `onRamp` / `offRampDestination` for the example | ramps, escrow |
| `DeliveryOracle` | `poll(cursor)` in claims, `deliveredSince(cursor)` in escrow; same event fields | claims, escrow |

`examples/order-flow/src/world.ts` (`SimClock`) shows one clock serving the seconds and milliseconds shapes.

## 1. Decide which orders qualify

Offer EURC only where the escrow can settle cleanly:

- **Single seller per order.** One escrow pays one receiver.
- **A delivery signal you trust.** Silent-buyer payouts need a delivery claim. Enable a destination
  only after your carrier's tracking has reported a delivery there.
- **A platform fee within Trustless Work's cap.** Compute it with the fee rules in
  `packages/escrow` (below); offer EURC only if `0 <= platform_fee_bps <= 9900`.
- **Exposure caps** per order and in total open escrow value until an external audit.

## 2. Price the escrow so the seller nets what the card rail pays

The escrow amount is what the buyer pays (items, shipping, buyer fee). Trustless Work takes 0.3%
and pays the platform its fee in basis points, both floored on the escrow amount. To make the
seller net at least the card-rail payout (`card_net`) and at most 1 basis point more:

```
platform_fee_bps = floor((9970 * amount - 10000 * card_net) / amount)     // 7-decimal units
```

Log the rounding remainder per order on its own reconciliation line. The 0.3% comes out of your
share.

## 3. Wallets (Privy or Stellar Wallets Kit)

- Buyers without a wallet: create a Privy embedded Stellar wallet owned by the user alone (no app
  authorisation key, no extra signers, no server-side export). Privy supports Stellar at its
  "Tier 2" level: the user signs the transaction hash in the browser with Privy's raw-hash signing.
  See https://docs.privy.io/wallets/overview/chains. TODO(verify, D2): re-check Privy's current Stellar
  tier and signing method before you ship.
- Buyers with a wallet: connect through Stellar Wallets Kit. Make the wallet the transaction source
  of every buyer call, so only `signTransaction` is needed (not every wallet signs Soroban auth
  entries).
- Privy does not decode Stellar transactions, so decode the XDR yourself and show the escrow ID,
  amount and asset before the user signs.

Code: [`packages/wallets`](../packages/wallets).

## 4. Sponsored accounts and EURC trustlines

Users should not need XLM. Your sponsor account creates the user's account with
`BeginSponsoringFutureReserves` and adds the EURC trustline in the same transaction; the user
co-signs `EndSponsoringFutureReserves` and the trustline. Afterwards, fee-bump only an allowlist
of single-operation transactions: `fund_escrow`, milestone approval and `dispute_escrow` on the
user's own order escrow, the buyer's `contest` on the guard, trustline operations, and the
seller's off-ramp payment to their stored ramp address. Cap inner fees, rate-limit per wallet, and
re-simulate before signing. Budget 1.5 XLM of locked reserve per sponsored wallet (account plus one
trustline).

Code: [`packages/eurc`](../packages/eurc).

## 5. Deploy your guard and registry

1. `./contracts/third_party/tw-wasm/fetch.sh` fetches Trustless Work's deployed Wasm by hash.
2. Deploy `claim-registry` with an issuer address and a separate, offline revoker address.
3. Deploy `guard` with its `Cfg`: admin (offline), resolver admin, the release, resolver and
   break-glass public keys, the registry, the EURC SAC, **your** platform fee address, the pinned
   Trustless Work Wasm hash for the network, Trustless Work's fee address on the testnet lineage
   (`None` on the mainnet lineage), and the three 7-day delays.

`scripts/testnet/deploy.ts` does this on testnet with runtime-generated keys.

## 6. Create each escrow (Trustless Work)

Create one single-release v1 escrow per order:

| Role | Value |
|---|---|
| approver | buyer wallet |
| service_provider | seller wallet |
| receiver | seller wallet (never a ramp deposit address) |
| platform | your platform fee address (the one pinned in the guard) |
| release_signer | your guard contract |
| dispute_resolver | your guard contract |
| trustline | EURC |
| platform_fee | from step 2 |
| amount | from step 2 |

Two creation paths:

- **REST API.** Trustless Work's v1 API returns unsigned XDR for deploy, fund, approve, dispute and
  release; the party that holds the role signs and you submit. Docs:
  https://docs.trustlesswork.com/trustless-work/api-rest/deploy.md. TODO(verify, D1): confirm with
  Trustless Work that the v1 API accepts a contract address as `release_signer` and
  `dispute_resolver`, the same address in both, and a non-empty milestone status.
- **On-chain deployer (fallback, proven on testnet).** Deploy Trustless Work's published Wasm
  through its deployer entry point `tw_new_single_release_escrow`, deploying and initialising in
  one transaction. TODO(verify, D1): confirm Trustless Work is fine with integrators using this path.

Then, before you show the buyer anything:

1. Make every field final. If a milestone status is empty, set it with `update_escrow` now: an
   empty status can never be approved, and any balance (even third-party dust) freezes the escrow.
2. Run `guard.check_escrow(escrow)` by simulation, and re-read `get_escrow`, comparing amount,
   platform fee, approver, receiver, service provider and receiver memo with the order.
3. Build the buyer's `fund_escrow(signer, expected_escrow, amount)` with exactly the amount and the
   escrow state you just read as `expected_escrow`.

Code: [`packages/escrow`](../packages/escrow).

## 7. Mark the order paid only on the buyer's own funding

Read funding events. Mark the order paid only when a `fund_escrow` signed by the order's buyer
wallet has brought the balance to at least the escrow amount. Then call
`guard.register_escrow(escrow)` (permissionless). Hold the seller payout as your card rail does.

## 8. Delivery claims

When your carrier reports the order's parcel delivered, build a claim leaf
([leaf-format.md](leaf-format.md)), add it to the current batch, and anchor the batch root on a
schedule (hourly works) with `registry.anchor(batch_id, root)`. Keep the per-order salt and the
proof; you need them for a silent-buyer resolution and for audits. The same job extends the TTL of
the registry, the guard, its registrations, open escrows and their EURC balance entries.

Code: [`packages/claims`](../packages/claims).

## 9. Settle

| Situation | What you submit | Guard branch |
|---|---|---|
| Buyer approves | `release_funds(guard[, tw_fee])` | Release key |
| Buyer silent 7 days after the claim was anchored | Platform opens a dispute; then `resolve_dispute({seller: amount, buyer: excess})` with the claim | Resolver key + claim |
| Buyer approved, seller (or anyone) disputed, no contest for 7 days | `resolve_dispute({seller: amount, buyer: excess})` | Resolver key, no claim |
| Refund before release | Dispute; `resolve_dispute({buyer: balance})`; then a top-up of both fees from your fee account | Resolver key (or break-glass) |
| Excess after release | `withdraw_remaining_funds({buyer: excess})`; top up the fees | Resolver key |

Trustless Work's REST release endpoints return an unsigned XDR for a G-account signer and do not
build the Soroban auth entry that the guard's `__check_auth` checks. A contract account authorises
through that entry, which can be attached to any re-simulated transaction, so build and simulate
these calls directly against the escrow through Soroban RPC with the guard's authorisation entry. Rebuild a resolution from the balance read just before submission
(the map must sum exactly to the live balance). Before any payout, check the recipient's EURC
trustline exists and is authorised.

For a buyer who wants to dispute an order they already approved, submit `register_escrow` (if
needed), then the buyer-signed `contest`, then `dispute_escrow`, as separate transactions.

## 10. Ramps (Bridge)

- **On-ramp:** the buyer completes Bridge KYC through Bridge's hosted link and pays euros by SEPA
  into a Bridge virtual account; Bridge delivers EURC on Stellar to the buyer's wallet. Create the
  buyer's EURC trustline before the virtual account. Quote the SEPA amount gross of Bridge's fees.
- **Off-ramp:** the escrow pays the seller's own wallet. The seller then sends EURC as a plain
  Stellar payment to their stored Bridge liquidation address (memoless address, or address plus
  memo); check the destination against the stored address before signing.
- **Travel Rule:** attach originator and beneficiary data and a wallet-ownership proof (the wallet
  signs a challenge) to each virtual account and liquidation address.

Bridge docs: https://apidocs.bridge.xyz (virtual accounts, liquidation addresses, KYC links,
sandbox). TODO(verify, D5): confirm Bridge supports EUR/SEPA with EURC on Stellar for your entity before
you build on it; availability is per customer.

Code: [`packages/ramps`](../packages/ramps).

## 11. Reconcile

Every few minutes, compare each open escrow's on-chain balance, flags and outgoing EURC transfers,
and each refund top-up, with your ledger, to the cent. Flag any balance different from the escrow
amount (third parties can send EURC to an escrow). Publish a daily pass/fail line.

Code: [`packages/reconciler`](../packages/reconciler).

## 12. Before mainnet

- External audit of your guard and registry deployment.
- Legal review of each role you hold (release key, resolver key, opening disputes and editing
  escrows as platform, refund top-ups, sponsorship). The resolver key holder may be a licensed
  party; the guard's `resolver_admin` exists for that.
- Trustless Work's mainnet fee account must hold an authorised EURC trustline, or every exit of a
  mainnet EURC escrow reverts (see [architecture.md](architecture.md), failure modes).
- Monitoring from [threat-model.md](threat-model.md) live.
