/**
 * The WalletProvider port.
 *
 * Everything that needs a user's signature (escrow funding, milestone approval,
 * disputes, sponsored trustlines, off-ramp payments) depends on this interface
 * only. Adapters: `KeypairWallet` (tests and demos), `PrivyWalletProvider`
 * (embedded wallet, raw-hash signing) and `WalletsKitProvider` (Freighter,
 * xBull, LOBSTR and the other wallets Stellar Wallets Kit supports).
 */
import type { Transaction, xdr } from '@stellar/stellar-sdk';

export type WalletKind = 'keypair' | 'privy-embedded' | 'wallets-kit' | 'raw-hash';

export interface WalletCapabilities {
  /**
   * Whether `signAuthEntry` works. Escrow calls use the wallet as the
   * transaction source, so `signTransaction` is enough for the main flow;
   * some external wallets (for example LOBSTR and xBull) do not sign auth entries.
   */
  authEntries: boolean;
}

export interface WalletProvider {
  readonly kind: WalletKind;
  /** The network this wallet signs for. Transactions for any other network are refused. */
  readonly networkPassphrase: string;
  readonly capabilities: WalletCapabilities;

  /** The wallet's Stellar account (`G...`). */
  getAddress(): Promise<string>;

  /**
   * Signs a transaction (not a fee-bump envelope) and returns a signed copy.
   * The input object is never mutated. Implementations verify the resulting
   * signature before returning.
   */
  signTransaction(tx: Transaction): Promise<Transaction>;

  /**
   * Returns the raw 64-byte Ed25519 signature over SHA-256 of the preimage XDR.
   * Throws `WalletError('UNSUPPORTED')` when `capabilities.authEntries` is false.
   * Use `authorizeEntryWithWallet` to place it into an entry.
   */
  signAuthEntry(preimage: xdr.HashIdPreimage): Promise<Uint8Array>;
}
