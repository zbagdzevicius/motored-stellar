/**
 * RawHashWallet: any signer that signs a 32-byte hash and returns a bare
 * Ed25519 signature, adapted to the WalletProvider port.
 *
 * The Privy adapter is a thin layer over this class. It is also the right
 * shape for an HSM or KMS-backed key.
 */
import { Networks, StrKey, Transaction, xdr } from '@stellar/stellar-sdk';

import { WalletError } from './errors.js';
import {
  type Hex0x,
  attachRawSignature,
  authEntryPayload,
  bytesToHex0x,
  cloneTransaction,
  hexToBytes,
  transactionHashHex,
  verifyRawSignature,
} from './raw-signature.js';
import { type BeforeSignHook, runBeforeSign } from './review.js';
import type { WalletCapabilities, WalletKind, WalletProvider } from './types.js';

/**
 * Signs `hash` with the key behind `address` and returns the 64-byte Ed25519
 * signature as hex (with or without `0x`) or as bytes.
 */
export type RawHashSigner = (request: { address: string; hash: Hex0x }) => Promise<string | Uint8Array>;

export interface RawHashWalletOptions {
  address: string;
  signRawHash: RawHashSigner;
  /** Defaults to testnet. */
  networkPassphrase?: string;
  beforeSign?: BeforeSignHook;
  kind?: WalletKind;
}

function toBytes(sig: string | Uint8Array): Uint8Array {
  return typeof sig === 'string' ? hexToBytes(sig) : sig;
}

export class RawHashWallet implements WalletProvider {
  readonly kind: WalletKind;
  readonly networkPassphrase: string;
  readonly capabilities: WalletCapabilities = { authEntries: true };

  readonly #address: string;
  readonly #signRawHash: RawHashSigner;
  readonly #beforeSign: BeforeSignHook | undefined;

  constructor(options: RawHashWalletOptions) {
    if (!StrKey.isValidEd25519PublicKey(options.address)) {
      throw new WalletError('PROVIDER_ERROR', `not a Stellar account address: ${options.address}`);
    }
    this.kind = options.kind ?? 'raw-hash';
    this.networkPassphrase = options.networkPassphrase ?? Networks.TESTNET;
    this.#address = options.address;
    this.#signRawHash = options.signRawHash;
    this.#beforeSign = options.beforeSign;
  }

  async getAddress(): Promise<string> {
    return this.#address;
  }

  /**
   * Hash the envelope, have the wallet sign the hash, attach the signature as a
   * DecoratedSignature. The result can go straight to RPC or into a sponsor's
   * fee-bump (the inner signature covers the inner transaction hash only).
   */
  async signTransaction(tx: Transaction): Promise<Transaction> {
    if (tx.networkPassphrase !== this.networkPassphrase) {
      throw new WalletError('NETWORK_MISMATCH', 'transaction was built for a different network');
    }
    await runBeforeSign(this.#beforeSign, tx);
    const copy = cloneTransaction(tx);
    const signature = await this.#signRawHash({ address: this.#address, hash: transactionHashHex(copy) });
    attachRawSignature(copy, this.#address, toBytes(signature));
    return copy;
  }

  async signAuthEntry(preimage: xdr.HashIdPreimage): Promise<Uint8Array> {
    const payload = authEntryPayload(preimage);
    const signature = toBytes(await this.#signRawHash({ address: this.#address, hash: bytesToHex0x(payload) }));
    if (!verifyRawSignature(this.#address, payload, signature)) {
      throw new WalletError('BAD_SIGNATURE', `signature does not verify for ${this.#address} over the auth entry`);
    }
    return signature;
  }
}
