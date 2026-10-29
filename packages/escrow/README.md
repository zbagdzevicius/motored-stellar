# @motored-stellar/escrow

Trustless Work v1 single-release escrow in EURC for one marketplace order, the
guard-authorised release service, and the money rules that decide the platform
fee, the caps, the rounding and the refund top-up. Testnet only.

Serves SCF deliverables:

| Deliverable | What in this package |
|---|---|
| D1 Trustless Work escrow in EURC | `TrustlessWorkRestClient` (v1 REST), `deployer.ts` (on-chain deployer fallback, deploy + init in one transaction), `precheck.ts` (`guard.check_escrow` + `get_escrow` re-read before a funding call), `events.ts` (event reader), `lifecycle.ts` |
| D3b escrow ledger rules | `fees.ts`: `platform_fee_bps = floor((9970 * amount - 10000 * card_net) / amount)`, cap 9,900, half-up card-rail rounding, Trustless Work fee floors, refund top-up |
| D6 release service auth path | `release-service.ts` + `guard-auth.ts`: `release_funds`, `resolve_dispute` and `withdraw_remaining_funds` with the guard's custom-account authorization entry |
| D4 end-to-end building block | `ports.ts` + in-memory implementations used by `examples/order-flow` |

## How it fits

```
buyer wallet --fund_escrow--> Trustless Work escrow (EURC) <--release/resolve-- release service
                                   |  release_signer = dispute_resolver = guard contract
                                   v
                          guard.__check_auth (release / resolver / break-glass key)
                                   |
                          claim registry (write-once delivery roots)
```

Nothing here imports a marketplace's private system. It plugs in through ports
(`src/ports.ts`), each with an in-memory implementation:

| Port | Purpose | In-memory | Real adapter |
|---|---|---|---|
| `EscrowApi` | Trustless Work operations | `InMemoryEscrowApi` (models the v1 contract rules) | `TrustlessWorkRestClient` |
| `Signer`, `KeyStore` | ed25519 signatures over tx hashes and auth payloads | `KeypairSigner` (runtime `Keypair.random()`), `InMemoryKeyStore` | your KMS or wallet |
| `Submitter` | simulate, submit | `InMemorySubmitter` | `RpcSubmitter` |
| `EventSource` | `getEvents` by contract and topic, with a cursor | `InMemoryEventSource` (loads a committed RPC response) | `RpcEventSource` |
| `OrderSource`, `DeliveryOracle` | the order's buyer, seller, amount, card net; carrier delivered events | `InMemoryOrderSource`, `InMemoryDeliveryOracle` | your order and carrier systems |
| `WalletProvider`, `RampProvider` | user wallets, fiat ramps | in-memory | `packages/wallets`, `packages/ramps` |
| `LedgerSource`, `ReportSink` | reconciliation inputs and outputs | in-memory | `packages/reconciler` |
| `Clock` | time | `ManualClock` | `systemClock` |

## Money rules in short

- Escrow amount = items + shipping + buyer fee (5% of items, capped at EUR 5, 0 under a referral). Rates are parameters (`FeeSchedule`), defaults 500 / 500 / 500.
- The seller nets at least the card-rail net (each item minus a 5% commission, rounded half up per item) and at most 1 basis point of the amount plus 2 units of flooring more. Property-tested over 50,000 seeded orders.
- An order whose fee would exceed 9,900 bps (Trustless Work's cap) is card-only.
- Trustless Work's 0.3% and the platform fee are floored on the same base; resolutions split them per recipient (mirrors `calculator.rs` and `distribution.rs` of the v1 contract).
- Refund before release: the escrow pays the buyer the balance less both fees; the platform tops up exactly those two amounts, so the buyer receives 100%.
- Paid means the buyer's own `fund_escrow` calls reach the amount. Partial funding, a third party's funding and plain transfers never mark an order paid; excess is flagged.
- Cancellation before funding rewrites the title (a field frozen once funded), so it works only at balance 0 and invalidates the buyer's prepared funding call.

## Usage sketch

```ts
import { TESTNET, TrustlessWorkRestClient, EscrowLifecycle, stellarSignXdr, EscrowEventReader, RpcSubmitter, RpcEventSource } from '@motored-stellar/escrow';

const api = new TrustlessWorkRestClient({
  baseUrl: TESTNET.trustlessWorkApiBase,
  apiKey: config.trustlessWorkApiKey, // injected by you; this package never reads the environment
  trustline: { address: eurcIssuer, symbol: 'EURC' },
});
const rpc = new RpcSubmitter(TESTNET.rpcUrl);
const reader = new EscrowEventReader(new RpcEventSource(rpc.server), { tokenContractId: eurcSac });
const lifecycle = new EscrowLifecycle(api, stellarSignXdr(TESTNET.networkPassphrase), reader, {
  platform, guardAddress: guardContractId, tokenContractId: eurcSac,
});
```

A Trustless Work API key is requested in Trustless Work's dApp (see their docs,
"Request API Key"); use a testnet key with `https://dev.api.trustlesswork.com`.

## Test

```bash
npm test -w @motored-stellar/escrow      # vitest, no network
npm run typecheck -w @motored-stellar/escrow
```

Tests cover the fee property test, cap, buyer fee and floors; the refund top-up;
the event decoder against real testnet events in `test/fixtures` (public data);
the REST client against a fetch mock; guard auth-entry signing (signature verifies
with the key and is bound to network, contract and function) and the release
service's record, sign, enforce and submit sequence; the precheck; and the
lifecycle over the in-memory escrow model.

## Open items

Search the source for `TODO(verify`: the REST client markers in `src/tw-rest.ts` read `TODO(verify, D1 live API run)` and close in the D1 run against the live v1 API. Open: REST units for `amount` and `platformFee`,
the REST trustline address form, the `distributions` and `update-escrow` body
shapes, which response carries a deployed escrow's ID, the official testnet
deployer contract ID, the SDK's `simulateTransaction` auth-mode parameter, and
the SAC transfer event's muxed data form.

License: Apache-2.0.
