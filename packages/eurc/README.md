# @motored-stellar/eurc

EURC handling on Stellar for an escrow marketplace, so a buyer or seller can
hold and move EURC with 0 XLM in their wallet. Serves SCF deliverable
**D2: sponsored accounts, EURC trustlines and fee-bumps**.

Testnet only. Mainnet constants are kept as documented references and are
asserted by tests, but no submitter in this package accepts the public
network.

## What is in it

| Module | What it does |
|---|---|
| `asset.ts` | EURC constants (testnet issuer `GB3Q6QDZ...`, mainnet issuer `GDHU6WRG...`, mainnet SAC `CDTKPWPL...` as reference), issuer flags, SAC id derivation, 7-decimal amount helpers, the XEUR stand-in |
| `trustline.ts` | Trustline status (`no-account`, `missing`, `frozen`, `present`) and `canReceive` (C-addresses need no trustline; G-addresses do) |
| `sponsorship.ts` | CAP-33 builders: sponsored `createAccount(0)` plus trustlines, sponsored trustline for an existing account, and the user-sourced sandwich |
| `feebump/policy.ts` | The allowlist: which inner transactions the sponsor will pay for |
| `feebump/service.ts` | Policy check, per-wallet rate limit, Soroban re-simulation, fee-bump build, fee cap, sponsor signature, submit |
| `ports.ts`, `memory.ts` | `Signer`, `Submitter`, `AccountReader`, `WalletRegistry`, `RateLimiter`, `Clock` and their in-memory implementations |
| `adapters/horizon-rpc.ts` | Horizon + Soroban RPC implementations of `Submitter` and `AccountReader` (configurable `rpcUrl`) |
| `testnet/standin.ts` | Friendbot, XEUR issue and SAC deploy builders for demos |

## The fee-bump allowlist

The sponsor wraps an inner transaction only when its source is a registered
wallet that signed it, its validity is bounded, its fee is under the cap, and
it is exactly one of:

| Shape | Rule |
|---|---|
| `fund_escrow(signer, expected_escrow, amount)` | on one of the source's escrows, `signer` = source, `amount` > 0 |
| `approve_milestone(milestone_index, approver)` | on one of the source's escrows, `approver` = source |
| `dispute_escrow(signer)` | on one of the source's escrows, `signer` = source |
| guard `contest(escrow, evidence)` | `escrow` is one of the source's escrows, `evidence` is 32 bytes |
| sponsored EURC trustline | Begin (source = sponsor, sponsored = source), ChangeTrust(EURC, default limit), End |
| classic EURC payment | to the source's stored ramp destination, with the ramp's memo |
| classic EURC payment (shipping) | to the configured `platformAddress` (the guard's pinned platform address): the order's shipping, paid outside the escrow in the funding step |

Soroban calls may carry only source-account authorisation. Anything else is
rejected with a reason code (`destination-not-allowed`, `operation-not-allowed`,
`operation-count`, `fee-above-cap`, `unregistered-source`, ...), and nothing
is signed or submitted. Escrow function names and argument orders are taken
from Trustless Work's escrow contract source.

## Lab evidence (testnet)

| Claim | Result |
|---|---|
| Sponsored `createAccount(0)` + 2 trustlines, user at 0 XLM | success, `8dccb9ab...` |
| Same without the user's signature | `op_bad_auth` |
| `createAccount(0)` without sponsorship | `op_low_reserve` |
| 0-XLM user's SAC transfer into a contract, fee-bumped by the sponsor | success, `9e0d5cb5...`, fee charged 3,848,293 stroops |
| Same without a fee-bump | `txInsufficientBalance` |
| Sponsor tries to move the user's funds | `op_bad_auth` (sponsorship gives no signing power) |
| Sponsored trustline for an existing 1-XLM account | success, `02c62e1c...` |
| Unsponsored trustline for that account | `op_low_reserve` |

Reserves: 1.5 XLM per sponsored wallet (account plus one trustline), locked
on the sponsor while the entries exist.

## Test

```bash
npm test -w @motored-stellar/eurc        # vitest, no network
npm run typecheck -w @motored-stellar/eurc
```

The tests cover: the sponsored-create transaction shape (sponsor is the
transaction and Begin source, the user is the source of ChangeTrust and End,
both signatures verify); every allowed fee-bump shape and each rejection
(payment to an arbitrary address, SetOptions, extra operations, inner fee
above the cap, unregistered or unsigned source, foreign escrow, foreign
authorisation, wrong network, unbounded validity); the service's rate limit,
re-simulation and fee-bump cap; trustline detection; and SAC id derivation
against stellar-sdk's `Asset.contractId`, plus the documented mainnet SAC id.

## Testnet demo

```bash
npm run demo:standin -w @motored-stellar/eurc
```

Generates throwaway keys with `Keypair.random()`, funds them with friendbot,
creates two sponsored 0-XLM accounts with XEUR trustlines, issues XEUR, then
sends one allowlisted off-ramp payment through the fee-bump service and shows
a payment to an arbitrary address being refused. Keys stay in memory; only
public keys and hashes are printed. Set `STELLAR_RPC_URL` to use your own RPC.

XEUR is a stand-in for EURC (Circle's testnet faucet may not be available to
every reviewer); it uses the same classic-asset and SAC paths.

## Using it from a host system

Implement `WalletRegistry` over your user and order tables (which G-addresses
are your users, which escrow ids belong to each, each seller's ramp deposit
address), back `RateLimiter` with your database, and construct the service:

```ts
const service = new FeeBumpService({
  policy: new FeeBumpPolicy({ networkPassphrase, eurc, guardContractId, sponsorPublicKey, registry }),
  sponsor,                     // a Signer for the sponsor key (HSM, KMS or KeypairSigner)
  submitter: new HorizonRpcSubmitter(testnetWith({ rpcUrl: "https://your-rpc" })),
  rateLimiter,
});
const result = await service.bumpAndSubmit(signedInnerTx);
```

## Open items

- `DEFAULT_FEE_CAPS.sorobanTotalFee` (1 XLM) was calibrated on 29 Oct 2026
  against testnet runs 4-6: `fund_escrow` declared 1,126,545 stroops (charged
  107,507), guard `contest` declared 1,009,996 (charged 5,108). Re-check
  against mainnet fees before mainnet use.
- `TODO(verify, D5)`: the memo type the ramp provider issues for Stellar deposits (Bridge sandbox run).
- `TODO(verify, D10)`: re-read the mainnet EURC issuer flags before any mainnet use (mainnet cutover).
