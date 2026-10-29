# @motored-stellar/wallets

Wallet connector layer for the EURC escrow flow. Serves SCF deliverable **D2: Privy embedded wallets and Stellar Wallets Kit**.

Everything that needs a buyer's or seller's signature (funding an escrow, approving a milestone, opening a dispute, a sponsored trustline, an off-ramp payment) depends on one port, `WalletProvider`:

```ts
interface WalletProvider {
  readonly kind: 'keypair' | 'privy-embedded' | 'wallets-kit' | 'raw-hash';
  readonly networkPassphrase: string;
  readonly capabilities: { authEntries: boolean };
  getAddress(): Promise<string>;                                  // G...
  signTransaction(tx: Transaction): Promise<Transaction>;         // signed copy, verified
  signAuthEntry(preimage: xdr.HashIdPreimage): Promise<Uint8Array>; // raw 64-byte signature
}
```

| Adapter | Use | Backend |
|---|---|---|
| `KeypairWallet` | tests, the runnable example, testnet scripts | in-memory `Keypair` (secret never exposed or serialised) |
| `PrivyWalletProvider` | embedded wallet in the browser | Privy raw-hash signing, injected as a function |
| `WalletsKitProvider` | the user's own wallet (Freighter, xBull, LOBSTR, ...) | Stellar Wallets Kit, injected structurally |
| `RawHashWallet` | any "sign these 32 bytes" signer (HSM, KMS) | injected `RawHashSigner` |

## Raw-hash signing

Privy supports Stellar as a raw-signing chain: it holds an Ed25519 key and signs a 32-byte hash. The app builds the transaction, computes `tx.hash()` (SHA-256 of the network-bound signature base), asks the wallet to sign that hash, and attaches the 64-byte result as a `DecoratedSignature` whose hint is the last 4 bytes of the signer's public key. `attachRawSignature` verifies the signature before attaching it. The resulting envelope is byte-identical to `tx.sign(keypair)` (Ed25519 is deterministic), which the tests check.

This path was proven on testnet in the SCF #46 wallet lab: a 0-XLM account signed, by raw hash, a sponsored account creation with EURC trustlines (tx `8dccb9ab850b82f713cee6606e678ef9288d8719bceb65024a12db517a9aef36`) and a Soroban token transfer to a contract address that a sponsor wrapped in a fee-bump (fee-bump tx `9e0d5cb5481929171c000b85a1077a754cb550885bcc38aa22f0c1c97fe1f5f7`). See `docs/verification.md`.

## Privy

Two halves, both injected so this package holds no Privy credentials and imports no Privy SDK:

- **Server:** `EmbeddedWalletService` creates a Stellar wallet owned by the user alone (owner = the Privy user ID; no app authorisation key, no additional signers) after a caller-supplied `WalletEligibility` predicate passes, and checks Privy's response (Stellar chain, valid `G...`, no additional signers). `PrivyRestClient` calls `POST https://api.privy.io/v1/wallets` with `appId`/`appSecret` from your secret store; `InMemoryPrivyClient` is the test double.
- **Browser:** `PrivyWalletProvider` takes the `signRawHash` function from `useSignRawHash()` (`@privy-io/react-auth/extended-chains`) and calls it with `{ address, chainType: 'stellar', hash: '0x...' }`.

Fee and reserve sponsorship do not come from Privy; the platform's sponsor account fee-bumps the signed transaction.

```ts
import { useSignRawHash } from '@privy-io/react-auth/extended-chains';
const { signRawHash } = useSignRawHash();
const wallet = new PrivyWalletProvider({ address, signRawHash, beforeSign: showReviewDialog });
const signed = await wallet.signTransaction(fundEscrowTx); // then fee-bump and submit
```

## Stellar Wallets Kit

```ts
import { StellarWalletsKit } from '@creit.tech/stellar-wallets-kit/sdk';
const wallet = new WalletsKitProvider({ kit: StellarWalletsKit, networkPassphrase: Networks.TESTNET });
```

The adapter checks what the wallet returns: the same transaction hash (`TX_TAMPERED` otherwise), the connected account as signer (`SIGNER_MISMATCH`), a signature that verifies (`BAD_SIGNATURE`), and the wallet's network when the kit reports it (`NETWORK_MISMATCH`). Auth-entry signing is off by default because the escrow flow uses the wallet as the transaction source and several wallets (LOBSTR, xBull) do not sign auth entries; enable it with `enableAuthEntries: true`.

## Pre-sign review

Every adapter accepts a `beforeSign(summary, tx)` hook. `summarizeTransaction` decodes the envelope into JSON-safe operations (contract ID, function and arguments for contract calls; destination, asset and amount for payments) so the UI can show the escrow ID, amount and asset before the wallet prompt. Returning `false` aborts with `REJECTED_BY_USER`.

## Errors

All adapters throw `WalletError` with a `code`: `NOT_ELIGIBLE`, `BAD_SIGNATURE`, `SIGNER_MISMATCH`, `TX_TAMPERED`, `NETWORK_MISMATCH`, `REJECTED_BY_USER`, `UNSUPPORTED`, `PROVIDER_ERROR`.

## Test

```bash
npm test -w @motored-stellar/wallets
```

Offline only: transactions are built and signed locally and never submitted. Tests cover the raw-hash path against an independent Ed25519 implementation (tweetnacl, as in the lab), the fee-bump and sponsored-creation shapes from the lab, auth-entry signing, a shared `WalletProvider` contract run against every adapter, the Privy request shape against a `fetch` mock, and the kit adapter against a mock kit that can misbehave.

## Peer dependencies

Both are optional; the adapters are typed structurally and never import them.

- `@privy-io/react-auth` (lab used 3.51.0)
- `@creit.tech/stellar-wallets-kit` (lab used 2.7.1)

## Open items

- TODO(verify): Stellar Wallets Kit v2 documents installation from JSR (`@creit-tech/stellar-wallets-kit`); the lab installed the npm tarball `@creit.tech/stellar-wallets-kit@2.7.1`. Confirm the npm name stays current for v2.
- TODO(verify): what each kit module's `signAuthEntry` takes and returns (base64 preimage in, base64 signature out is assumed).
- TODO(verify): Privy user ID format in examples varies between `did:privy:...` and `privy:did:...`; this package passes it through unchanged.
- TODO(verify): Privy create-wallet idempotency is sent as the `idempotency_key` body field listed in the API reference.

License: Apache-2.0.
