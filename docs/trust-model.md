# Trust model

The chain enforces **who can move escrowed EURC, to whom, and when**. It does not prove that a
parcel arrived: a delivery claim is the platform's signed, write-once, public record of the
carrier's delivery event. The design binds every seller payout that lacks the buyer's approval to
such a record, delays it by 7 days, and lets an offline key revoke it.

## Keys and roles

| Key | Holder | Can do | Cannot do |
|---|---|---|---|
| Buyer wallet | Buyer (embedded wallet owned by the user only, or own wallet) | Fund, approve, dispute; `contest` on the guard | The platform does not hold it |
| Seller wallet | Seller | Receive; dispute; cash out through a ramp | The platform does not hold it |
| Platform (fee account) | Platform | Receive fees; open a dispute on any escrow; change escrow properties while unfunded; append unapproved milestones to a funded escrow (which only blocks its release); send refund top-ups | Change the roles, amount, fee or receiver of a funded escrow; move escrowed funds |
| Release key | Platform release service | Co-authorise a release that Trustless Work has already conditioned on the buyer's approval and no open dispute | Release without the buyer's approval; pay anyone but the fixed seller and the two fee accounts |
| Resolver key | The platform, or a licensed party; a service account separate from the web service | Resolve a dispute; withdraw to the buyer; withdraw the seller's share alone under the seller rules, once (v0.10, so a buyer leg cannot block it) | Pay anyone but that escrow's buyer or seller; pay the seller more than the escrow amount; pay the seller without either a verified claim anchored after full funding and at least 7 days earlier, or the buyer's approval on record, a dispute, and 7 days without a buyer contest |
| Break-glass key | Platform, offline | Refund a disputed escrow's whole balance to its buyer | Pay the seller or anyone else; open a dispute |
| Registry issuer | Platform, separate service account | Anchor claim roots | Move funds; revoke |
| Registry revoker | Platform, offline | Revoke an anchored batch, so none of its claims verify again | Anchor; move funds |
| Sponsor/submitter | Platform | Pay reserves and fees; co-sign account creation; fee-bump allowlisted transactions; submit | Touch escrow balances or sign payments for users |
| Guard admin | Platform, offline | Propose new release, resolver and break-glass keys; they apply after a public 7-day timelock | Change keys without the public delay; move funds directly |
| Resolver admin | The resolver-key holder | Replace the resolver key at once | Change any other key |

The release, resolver and break-glass keys are raw ed25519 keys stored in the guard; they hold no
funds and rotate in-contract (7-day timelock, or at once for the resolver key). The guard admin,
the resolver admin and the registry's issuer and revoker are Stellar addresses fixed at
deployment, with no setter, and the guard's registry pointer is fixed too. Each is therefore a
multisig G-account, never a bare key: its signers rotate at the account level (add the new signer,
set the master weight to 0, remove the old one) without touching either contract. In this
repository the `Signer` and `KeyStore` ports abstract the keys; the in-memory implementations
generate fresh keys at runtime and never persist them. Production deployments should hold each
key on its own service identity, log every signature with its order reference, and keep the
admin, revoker and break-glass keys offline.

**Recovery after an issuer leak.** The offline revoker revokes every batch the leaked signer
anchored inside the 7-day wait, and the leaked signer is removed from the issuer account. If the
issuer account itself must be replaced, a new registry and a new guard pointing to it are
deployed for new escrows, while the revoker keeps watching the old registry until its last escrow
closes. Payouts still need the resolver key, so a leaked issuer alone moves no funds.

## What the platform's keys can and cannot do, stated plainly

For an escrow created with the guard in both roles on the pinned Trustless Work Wasm, the
platform's keys can:

- open a dispute on any escrow;
- through the guard, resolve it to that escrow's buyer at any time;
- resolve it to its seller once a platform-issued delivery claim, anchored after the escrow was
  fully funded, is at least 7 days old;
- resolve it to its seller once the buyer's approval of every milestone has been on record for 7
  days alongside a dispute, without a buyer contest.

No platform key can pay anyone except that escrow's buyer, its seller and the two fee recipients
the guard pins (Trustless Work's fee account and the platform address), and no resolution can give
the seller more than the escrow amount. The guard pins the recipients and caps the platform fee
rate: the rate is set when the escrow is created and checked against the order by the platform's
backend, and since v0.10 the guard refuses to register any escrow whose rate is above
`max_platform_fee_bps` (set per deploy (500 bps in run 9; 3,000 bps planned for mainnet, because the platform fee also carries the DPD shipping Motored buys; an order whose quote is above the cap stays on the card rail), fixed at construction; landed on testnet in
run 9; done pre-award, not billed).

Escrows created while the platform backend is compromised are outside this guarantee, except that
the guard's per-network pins (Trustless Work Wasm, EURC, the platform address, Trustless Work's
fee address) still hold, so the two fee recipients stay fixed, and the guard's platform fee cap
still holds, so such an escrow pays the platform at most the capped rate. The buyer's funding signature
commits to the escrow's roles through `expected_escrow`, and checkout shows the receiver before
signing, but an attacker who controls checkout could show false data.

A compromise of a runtime that holds several keys could pay sellers of existing escrows without
buyer approval no earlier than 7 days after a newly anchored claim, and sellers of buyer-approved
escrows after the 7-day contest window; never anyone else. Mitigations: separate service
identities for the resolver and issuer keys, an offline revoker, and alerts on every anchor and
resolution (see [threat-model.md](threat-model.md)).

## Trust in third parties

| Party | What you trust it for | What happens if it fails |
|---|---|---|
| Trustless Work | The escrow Wasm behaves as its source says; pinned by hash, no upgrade path | The guard refuses escrows on any other Wasm |
| Circle (EURC issuer) | Redemption; not freezing balances | A frozen escrow is locked for every party until unfrozen |
| Embedded wallet provider | User-only ownership configuration | Misconfiguration could give the app signing power; checked at wallet creation |
| Ramp provider | KYC, SEPA in and out | On-ramp or off-ramp delayed; escrow unaffected |
| Stellar RPC | Event delivery | Gaps covered by periodic full re-reads |

## Privacy

No directly identifying data goes on-chain. Claim leaves carry a random order reference and a
salted HMAC commitment to the parcel number, so parcel numbers cannot be brute-forced and linked
to a carrier's public tracking page. Escrow text fields carry random or generic values. Wallet
addresses, amounts and times are public and, where linkable to a user, are pseudonymous personal
data. Public reports are aggregates. The public re-check script proves Merkle inclusion and anchor
time, nothing more.
