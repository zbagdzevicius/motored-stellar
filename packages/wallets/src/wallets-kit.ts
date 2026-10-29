/**
 * Stellar Wallets Kit adapter (Freighter, xBull, LOBSTR, Albedo, Rabet,
 * WalletConnect and the other wallets the kit supports).
 *
 * The kit is typed structurally (`WalletsKitLike`), so this package does not
 * import it and it stays an optional peer dependency. Pass the kit's static
 * class after `StellarWalletsKit.init(...)`:
 *
 *   import { StellarWalletsKit } from '@creit.tech/stellar-wallets-kit/sdk';
 *   const wallet = new WalletsKitProvider({ kit: StellarWalletsKit, networkPassphrase: Networks.TESTNET });
 *
 * Method shapes below are copied from the published v2.7.1 typings
 * (`esm/sdk/kit.d.ts`). See https://stellarwalletskit.dev.
 */
import { Buffer } from 'buffer';
import { FeeBumpTransaction, Networks, StrKey, Transaction, TransactionBuilder, xdr } from '@stellar/stellar-sdk';

import { WalletError } from './errors.js';
import { authEntryPayload, hasValidSignatureFrom, verifyRawSignature } from './raw-signature.js';
import { type BeforeSignHook, runBeforeSign } from './review.js';
import type { WalletCapabilities, WalletProvider } from './types.js';

interface KitSignOptions {
  networkPassphrase?: string;
  address?: string;
  path?: string;
}

/** The subset of `StellarWalletsKit` (v2.x static API) this adapter calls. */
export interface WalletsKitLike {
  getAddress(): Promise<{ address: string }>;
  signTransaction(xdr: string, opts?: KitSignOptions): Promise<{ signedTxXdr: string; signerAddress?: string }>;
  signAuthEntry?(authEntry: string, opts?: KitSignOptions): Promise<{ signedAuthEntry: string; signerAddress?: string }>;
  getNetwork?(): Promise<{ network: string; networkPassphrase: string }>;
}

export interface WalletsKitProviderOptions {
  kit: WalletsKitLike;
  /** Defaults to testnet. */
  networkPassphrase?: string;
  beforeSign?: BeforeSignHook;
  /**
   * Opt in to auth-entry signing. Off by default: the escrow flow does not need
   * it and several wallets (LOBSTR, xBull) do not implement it.
   */
  enableAuthEntries?: boolean;
  /** When the kit exposes `getNetwork`, refuse to sign if the wallet is on another network. Default true. */
  checkWalletNetwork?: boolean;
}

export class WalletsKitProvider implements WalletProvider {
  readonly kind = 'wallets-kit' as const;
  readonly networkPassphrase: string;
  readonly capabilities: WalletCapabilities;

  readonly #kit: WalletsKitLike;
  readonly #beforeSign: BeforeSignHook | undefined;
  readonly #checkWalletNetwork: boolean;

  constructor(options: WalletsKitProviderOptions) {
    this.#kit = options.kit;
    this.networkPassphrase = options.networkPassphrase ?? Networks.TESTNET;
    this.#beforeSign = options.beforeSign;
    this.#checkWalletNetwork = options.checkWalletNetwork ?? true;
    this.capabilities = {
      authEntries: Boolean(options.enableAuthEntries && typeof options.kit.signAuthEntry === 'function'),
    };
  }

  async getAddress(): Promise<string> {
    const { address } = await this.#kit.getAddress();
    if (!StrKey.isValidEd25519PublicKey(address)) {
      throw new WalletError('PROVIDER_ERROR', 'connected wallet returned an invalid Stellar address');
    }
    return address;
  }

  /**
   * Sends the envelope to the user's wallet and checks what comes back: same
   * transaction hash (the wallet did not alter the transaction), signed by the
   * connected account, signature valid over the hash.
   */
  async signTransaction(tx: Transaction): Promise<Transaction> {
    if (tx.networkPassphrase !== this.networkPassphrase) {
      throw new WalletError('NETWORK_MISMATCH', 'transaction was built for a different network');
    }
    await this.#assertWalletNetwork();
    const address = await this.getAddress();
    await runBeforeSign(this.#beforeSign, tx);

    const { signedTxXdr, signerAddress } = await this.#kit.signTransaction(tx.toXDR(), {
      networkPassphrase: this.networkPassphrase,
      address,
    });
    if (signerAddress && signerAddress !== address) {
      throw new WalletError('SIGNER_MISMATCH', `wallet signed as ${signerAddress}, expected ${address}`);
    }

    let signed: Transaction | FeeBumpTransaction;
    try {
      signed = TransactionBuilder.fromXDR(signedTxXdr, this.networkPassphrase);
    } catch (cause) {
      throw new WalletError('PROVIDER_ERROR', 'wallet returned an unreadable transaction', { cause });
    }
    if (signed instanceof FeeBumpTransaction || !Buffer.from(signed.hash()).equals(tx.hash())) {
      throw new WalletError('TX_TAMPERED', 'wallet returned a different transaction than it was asked to sign');
    }
    if (!hasValidSignatureFrom(signed, address)) {
      throw new WalletError('BAD_SIGNATURE', `returned envelope has no valid signature from ${address}`);
    }
    return signed;
  }

  async signAuthEntry(preimage: xdr.HashIdPreimage): Promise<Uint8Array> {
    if (!this.capabilities.authEntries || !this.#kit.signAuthEntry) {
      throw new WalletError('UNSUPPORTED', 'auth-entry signing is not enabled for this wallet');
    }
    await this.#assertWalletNetwork();
    const address = await this.getAddress();
    // TODO(verify): wallets differ on what `signAuthEntry` takes and returns.
    // Freighter's API takes the base64 HashIdPreimage XDR and returns the
    // base64 64-byte signature over its SHA-256; confirm the kit passes both
    // through unchanged for every module we enable.
    const { signedAuthEntry, signerAddress } = await this.#kit.signAuthEntry(preimage.toXDR('base64'), {
      networkPassphrase: this.networkPassphrase,
      address,
    });
    if (signerAddress && signerAddress !== address) {
      throw new WalletError('SIGNER_MISMATCH', `wallet signed as ${signerAddress}, expected ${address}`);
    }
    const signature = Uint8Array.from(Buffer.from(signedAuthEntry, 'base64'));
    if (!verifyRawSignature(address, authEntryPayload(preimage), signature)) {
      throw new WalletError('BAD_SIGNATURE', `auth-entry signature does not verify for ${address}`);
    }
    return signature;
  }

  async #assertWalletNetwork(): Promise<void> {
    if (!this.#checkWalletNetwork || !this.#kit.getNetwork) return;
    const { networkPassphrase } = await this.#kit.getNetwork();
    if (networkPassphrase && networkPassphrase !== this.networkPassphrase) {
      throw new WalletError('NETWORK_MISMATCH', 'the connected wallet is on a different network');
    }
  }
}
