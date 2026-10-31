# @motored-stellar/ramps

SEPA on-ramp and off-ramp for EURC on Stellar, behind one small port.
Pre-award, not billed; used by SCF deliverable **D5: Bridge on-ramp and off-ramp in sandbox**.

- **Buyer on-ramp.** Hosted KYC link, then a EUR virtual account (an IBAN) whose
  SEPA deposits are delivered as EURC on Stellar to the buyer's own wallet. The
  buyer then funds the escrow from that wallet.
- **Seller off-ramp.** Hosted KYC/KYB link, the seller's IBAN as an external
  account, then a liquidation address: a classic EURC payment from the seller's
  wallet to it becomes a SEPA payout to the seller's bank.

## What is in the package

| Module | Purpose |
|---|---|
| `ports.ts` | `RampProvider` port and domain types; `HttpClient`, `Clock`, `TrustlineGate` ports |
| `bridge/provider.ts` | `BridgeRampProvider`: customers, KYC links, EUR external accounts, virtual accounts, liquidation addresses, transfers |
| `bridge/sandbox.ts` | `BridgeSandbox`: KYC approval and deposit simulations (sandbox only) |
| `bridge/http.ts` | `Api-Key` and `Idempotency-Key` headers, base URLs, error mapping; the key is never logged |
| `in-memory.ts` | `InMemoryRamp` + `InMemoryEurcLedger` for tests and `examples/order-flow` |
| `receiver.ts` | Escrow receiver rule and off-ramp pre-sign check |
| `travel-rule.ts` | EU Travel Rule payload, validation and the two self-transfer presets |
| `quote.ts` | Gross-up quote for the on-ramp and payout quote for the off-ramp, from a fee schedule input |
| `amounts.ts`, `sepa.ts` | Cents and 7-decimal EURC units as bigint; SEPA reference rule |

## Rules this package enforces

1. **The escrow receiver is always the seller's own plain G-address.** The
   gateway routes Stellar deposits to its shared account by memo, or by a
   memoless muxed (M-) address that encodes the memo. The escrow pays a plain
   `Address` and does not apply a memo, so `assertEscrowReceiver` rejects M-
   and C-addresses and any stored gateway deposit address.
2. **Off-ramp is a separate classic payment** from the seller's wallet to the
   stored memoless address, or to the address plus its memo.
   `checkOffRampPayment` runs right before signing.
3. **Trustline before virtual account.** With a `TrustlineGate`, the provider
   refuses to create a virtual account for a wallet that cannot hold EURC yet.
4. **Return instructions on Stellar** carry both an address and a memo, so a
   returned SEPA payout comes back to the seller's wallet.
5. **Travel Rule data** is attached at creation (both parties are `is_self`).
   Hosted and self-custodied wallets need a past `walletAttestedOwnershipAt`.
6. **Sandbox by default.** A sandbox key must start with `sk-test`.
   Production needs `allowProduction: true`. The API key comes from your
   secret store through config. It is never in code or fixtures.

## Usage

```ts
import { BridgeRampProvider, selfOnRampTravelRule, quoteOnRamp } from "@motored-stellar/ramps";

const ramp = new BridgeRampProvider({
  apiKey: process.env.BRIDGE_SANDBOX_API_KEY!, // sk-test-..., from your secret store
  trustlineGate: { hasEurcTrustline: async (g) => /* read Horizon or RPC */ true },
});

const link = await ramp.kycLink({ type: "individual", email, endorsements: ["sepa"] });
// ... customer completes the hosted flow; link.customerId is then set ...
const va = await ramp.createVirtualAccount(customerId, {
  destinationAddress: buyerG,
  travelRule: selfOnRampTravelRule({ buyerWalletType: "hosted", walletAttestedOwnershipAt }),
}, { idempotencyKey: `va-${orderRef}` });

const quote = quoteOnRamp(escrowAmountUnits, feeScheduleFromYourContract);
// Show va.deposit.iban / bic and quote.sepaCents to the buyer.
```

## Test

```bash
npm test -w @motored-stellar/ramps
```

The tests need no network and no credentials. They cover:

- request construction against a fetch mock: paths, `Api-Key` and
  `Idempotency-Key` headers, and bodies as in the gateway's docs;
- the receiver rule (G accepted; M, C and gateway deposit addresses rejected);
- gross-up math: the quote is sufficient and one cent less is not;
- the `InMemoryRamp` lifecycle: KYC pending to approved, a SEPA deposit
  credits EURC, the liquidation payout, an unmatched memo, and a returned payout.

## Sandbox and testnet

The gateway's sandbox simulates deposits and drains. It sends nothing to any
blockchain, so it delivers no testnet EURC. D5 is therefore shown in two
legs:

1. The **API leg** against the sandbox with `BridgeSandbox`: customer, simulated
   KYC approval, virtual account, liquidation address, then simulated deposits
   (`drain_id` returned).
2. The **on-chain leg** on Stellar testnet with the issuer's testnet EURC, using
   `InMemoryRamp` in place of the gateway (see `examples/order-flow`).

Static memos are not used. The gateway documents them as deprecated and as a
wire/ACH deposit route, so they do not apply to EUR on SEPA.

## TODO(verify)

These items are not confirmed by the saved docs. Each one is marked `TODO(verify, D5)` in the code
and closes in the D5 Bridge sandbox run:

- the response fields of `POST /customers` (`status` vs `kyc_status`);
- `business_name` on a business-owned EUR external account request;
- the Travel Rule originator on a fiat-to-crypto virtual account delivery;
- where a transfer carries its destination tx hash (assumed `receipt.destination_tx_hash`);
- the EURC amount precision `simulate_deposit` accepts;
- the gateway's fee composition and rounding. Quotes round every percentage
  fee up, so the real net is never below the quote;
- EUR to EURC at face value, with any spread carried as a percentage fee;
- how sub-cent dust on an off-ramp is handled;
- whether a returned SEPA payout returns the full EURC amount or the net.

License: Apache-2.0.
