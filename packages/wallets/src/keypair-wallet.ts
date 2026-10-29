/**
 * KeypairWallet: a local Ed25519 key behind the WalletProvider port.
 *
 * For unit tests, the runnable example and testnet scripts only. The secret
 * stays inside the in-memory Keypair; this class never exposes, logs or
 * serialises it. Production users sign through Privy or their own wallet.
 */
import { Buffer } from 'buffer';
import { Keypair, Networks, Transaction, xdr } from '@stellar/stellar-sdk';

import { WalletError } from './errors.js';
import { authEntryPayload, cloneTransaction } from './raw-signature.js';
import { type BeforeSignHook, runBeforeSign } from './review.js';
import type { WalletCapabilities, WalletProvider } from './types.js';

export interface KeypairWalletOptions {
  /** Defaults to testnet. */
  networkPassphrase?: string;
  beforeSign?: BeforeSignHook;
}

export class KeypairWallet implements WalletProvider {
  readonly kind = 'keypair' as const;
  readonly networkPassphrase: string;
  readonly capabilities: WalletCapabilities = { authEntries: true };

  readonly #keypair: Keypair;
  readonly #beforeSign: BeforeSignHook | undefined;

  constructor(keypair: Keypair, options: KeypairWalletOptions = {}) {
    if (!keypair.canSign()) {
      throw new WalletError('UNSUPPORTED', 'KeypairWallet needs a keypair that holds a secret');
    }
    this.#keypair = keypair;
    this.networkPassphrase = options.networkPassphrase ?? Networks.TESTNET;
    this.#beforeSign = options.beforeSign;
  }

  /** A fresh random key; fund it with friendbot on testnet before use. */
  static random(options: KeypairWalletOptions = {}): KeypairWallet {
    return new KeypairWallet(Keypair.random(), options);
  }

  get publicKey(): string {
    return this.#keypair.publicKey();
  }

  async getAddress(): Promise<string> {
    return this.#keypair.publicKey();
  }

  async signTransaction(tx: Transaction): Promise<Transaction> {
    if (tx.networkPassphrase !== this.networkPassphrase) {
      throw new WalletError('NETWORK_MISMATCH', 'transaction was built for a different network');
    }
    await runBeforeSign(this.#beforeSign, tx);
    const copy = cloneTransaction(tx);
    copy.sign(this.#keypair);
    return copy;
  }

  async signAuthEntry(preimage: xdr.HashIdPreimage): Promise<Uint8Array> {
    return Uint8Array.from(this.#keypair.sign(Buffer.from(authEntryPayload(preimage))));
  }

  /** Keeps the secret out of `console.log`, `util.inspect` and JSON output. */
  toJSON(): { kind: 'keypair'; address: string } {
    return { kind: this.kind, address: this.publicKey };
  }
}
