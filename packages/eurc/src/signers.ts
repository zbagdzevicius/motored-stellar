/**
 * Signer implementations and the helper that attaches a raw signature.
 *
 * The lab proved that an embedded wallet which only exposes "sign these 32
 * bytes" (ed25519 over the transaction hash) produces a valid Stellar
 * signature: the hash is signed, the 64-byte signature is attached with
 * `addSignature`, and the network accepts it (testnet, sponsored create
 * `8dccb9ab...`; fee-bumped Soroban call `9e0d5cb5...`). `attachSignature`
 * is that path, and it works for any `Signer`.
 */
import { Keypair, type FeeBumpTransaction, type Transaction } from "@stellar/stellar-sdk";
import type { Signer } from "./ports.js";

/** A Signer backed by an in-process stellar-sdk Keypair (tests, demos, ops keys). */
export class KeypairSigner implements Signer {
  constructor(private readonly keypair: Keypair) {
    if (!keypair.canSign()) throw new Error("KeypairSigner needs a keypair with a secret");
  }

  /** A fresh random key. Never persisted by this package. */
  static random(): KeypairSigner {
    return new KeypairSigner(Keypair.random());
  }

  publicKey(): string {
    return this.keypair.publicKey();
  }

  async signTxHash(txHash: Uint8Array): Promise<Uint8Array> {
    if (txHash.length !== 32) throw new Error("expected a 32-byte transaction hash");
    return Buffer.from(this.keypair.sign(Buffer.from(txHash)));
  }
}

/**
 * Sign `tx` with `signer` over its hash and attach the signature.
 * `addSignature` verifies the signature against the public key and the hash,
 * so a signer that returns garbage fails here, before submission.
 */
export async function attachSignature(
  tx: Transaction | FeeBumpTransaction,
  signer: Signer,
): Promise<void> {
  const sig = await signer.signTxHash(tx.hash());
  tx.addSignature(signer.publicKey(), Buffer.from(sig).toString("base64"));
}

/** Attach signatures from several signers, in order. */
export async function attachSignatures(
  tx: Transaction | FeeBumpTransaction,
  signers: readonly Signer[],
): Promise<void> {
  for (const s of signers) await attachSignature(tx, s);
}

/** True when `tx` carries a valid signature from `publicKey` over its hash. */
export function hasValidSignatureFrom(tx: Transaction | FeeBumpTransaction, publicKey: string): boolean {
  const kp = Keypair.fromPublicKey(publicKey);
  const hint = kp.signatureHint();
  const h = tx.hash();
  return tx.signatures.some(
    (d) => Buffer.from(d.hint()).equals(Buffer.from(hint)) && kp.verify(h, Buffer.from(d.signature())),
  );
}
