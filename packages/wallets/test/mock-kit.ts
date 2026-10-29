/**
 * A stand-in for `StellarWalletsKit` (v2.x static API) backed by a local key,
 * with switches for the ways a real wallet can misbehave.
 */
import { Buffer } from 'buffer';
import { Keypair, Networks, Operation, Transaction, TransactionBuilder, hash, xdr } from '@stellar/stellar-sdk';

import type { WalletsKitLike } from '../src/index.js';

export type KitMisbehaviour =
  | 'none'
  /** Signs with another key and says so in `signerAddress`. */
  | 'other-signer'
  /** Signs with another key but reports the expected address. */
  | 'lying-signer'
  /** Adds an operation before signing. */
  | 'tamper'
  /** Returns the envelope unsigned. */
  | 'no-signature';

export class MockKit implements WalletsKitLike {
  misbehaviour: KitMisbehaviour = 'none';
  network: string = Networks.TESTNET;
  readonly calls: Array<{ method: string; opts: unknown }> = [];
  readonly #key: Keypair;
  readonly #other = Keypair.random();

  constructor(key: Keypair) {
    this.#key = key;
  }

  async getAddress(): Promise<{ address: string }> {
    return { address: this.#key.publicKey() };
  }

  async getNetwork(): Promise<{ network: string; networkPassphrase: string }> {
    return { network: this.network === Networks.TESTNET ? 'TESTNET' : 'OTHER', networkPassphrase: this.network };
  }

  async signTransaction(
    txXdr: string,
    opts?: { networkPassphrase?: string; address?: string },
  ): Promise<{ signedTxXdr: string; signerAddress?: string }> {
    this.calls.push({ method: 'signTransaction', opts });
    const passphrase = opts?.networkPassphrase ?? this.network;
    let tx = TransactionBuilder.fromXDR(txXdr, passphrase) as Transaction;

    if (this.misbehaviour === 'tamper') {
      tx = TransactionBuilder.cloneFrom(tx, { fee: tx.fee, networkPassphrase: passphrase })
        .addOperation(Operation.bumpSequence({ bumpTo: '999999' }))
        .build();
    }
    const signer = this.misbehaviour === 'other-signer' || this.misbehaviour === 'lying-signer' ? this.#other : this.#key;
    if (this.misbehaviour !== 'no-signature') tx.sign(signer);

    return {
      signedTxXdr: tx.toXDR(),
      signerAddress: this.misbehaviour === 'other-signer' ? this.#other.publicKey() : this.#key.publicKey(),
    };
  }

  async signAuthEntry(
    authEntry: string,
    opts?: { networkPassphrase?: string; address?: string },
  ): Promise<{ signedAuthEntry: string; signerAddress?: string }> {
    this.calls.push({ method: 'signAuthEntry', opts });
    const preimage = xdr.HashIdPreimage.fromXDR(authEntry, 'base64');
    const signer = this.misbehaviour === 'lying-signer' ? this.#other : this.#key;
    const sig = signer.sign(hash(preimage.toXDR()));
    return { signedAuthEntry: Buffer.from(sig).toString('base64'), signerAddress: this.#key.publicKey() };
  }
}
