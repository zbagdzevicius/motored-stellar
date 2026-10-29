/**
 * Raw-hash signing primitives.
 *
 * Wallets that only expose "sign these 32 bytes" (Privy's raw-hash signing for
 * Stellar, an HSM, a KMS) never see a Stellar transaction. The app computes the
 * transaction hash, the wallet returns a bare 64-byte Ed25519 signature, and
 * this module turns that signature into a Stellar `DecoratedSignature`
 * (signature hint = last 4 bytes of the signer's public key) on the envelope.
 *
 * The same path was proven on testnet in the SCF #46 wallet lab: a 0-XLM
 * embedded-wallet account signed a sponsored account creation and a Soroban
 * token transfer that a sponsor then wrapped in a fee-bump (see
 * docs/verification.md, wallet experiments W-01, W-04, W-05).
 */
import { Buffer } from 'buffer';
import {
  FeeBumpTransaction,
  Keypair,
  StrKey,
  Transaction,
  TransactionBuilder,
  authorizeEntry,
  hash,
  xdr,
} from '@stellar/stellar-sdk';

import { WalletError } from './errors.js';

/** A `0x`-prefixed lowercase hex string, the format Privy uses for hashes and signatures. */
export type Hex0x = `0x${string}`;

const ED25519_SIGNATURE_BYTES = 64;

/** Decodes hex with or without a `0x` prefix. Throws on odd length or non-hex characters. */
export function hexToBytes(hex: string): Uint8Array {
  const body = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
  if (body.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(body)) {
    throw new WalletError('BAD_SIGNATURE', 'value is not valid hex');
  }
  return Uint8Array.from(Buffer.from(body, 'hex'));
}

/** Encodes bytes as `0x`-prefixed lowercase hex. */
export function bytesToHex0x(bytes: Uint8Array): Hex0x {
  return `0x${Buffer.from(bytes).toString('hex')}`;
}

/** The 32-byte network-bound hash a Stellar signer signs, as `0x` hex. */
export function transactionHashHex(tx: Transaction | FeeBumpTransaction): Hex0x {
  return bytesToHex0x(tx.hash());
}

/** True when `signature` is a 64-byte Ed25519 signature by `publicKey` over `payload`. */
export function verifyRawSignature(publicKey: string, payload: Uint8Array, signature: Uint8Array): boolean {
  if (signature.length !== ED25519_SIGNATURE_BYTES) return false;
  if (!StrKey.isValidEd25519PublicKey(publicKey)) return false;
  try {
    return Keypair.fromPublicKey(publicKey).verify(Buffer.from(payload), Buffer.from(signature));
  } catch {
    return false;
  }
}

/**
 * Wraps a raw Ed25519 signature as a Stellar `DecoratedSignature`.
 *
 * The hint is the last 4 bytes of the signer's account ID XDR, which equals the
 * last 4 bytes of the raw 32-byte public key (`Keypair.signatureHint()`).
 */
export function decoratedSignatureFromRaw(publicKey: string, signature: Uint8Array): xdr.DecoratedSignature {
  return new xdr.DecoratedSignature({
    hint: Keypair.fromPublicKey(publicKey).signatureHint(),
    signature: Buffer.from(signature),
  });
}

/**
 * Verifies a raw signature over the transaction hash and appends it to the
 * envelope. Accepts the signature as bytes or as hex (Privy returns `0x` hex).
 *
 * Unlike `tx.addDecoratedSignature`, this refuses a signature that does not
 * verify, so a misbehaving signer can never produce an envelope that fails
 * later with an opaque `tx_bad_auth`.
 */
export function attachRawSignature(
  tx: Transaction | FeeBumpTransaction,
  publicKey: string,
  signature: Uint8Array | string,
): void {
  const sig = typeof signature === 'string' ? hexToBytes(signature) : signature;
  if (!verifyRawSignature(publicKey, tx.hash(), sig)) {
    throw new WalletError('BAD_SIGNATURE', `signature does not verify for ${publicKey} over the transaction hash`);
  }
  tx.addDecoratedSignature(decoratedSignatureFromRaw(publicKey, sig));
}

/**
 * True when the envelope carries at least one signature by `publicKey` that
 * verifies over the transaction hash. Used to check what an external wallet
 * returned.
 */
export function hasValidSignatureFrom(tx: Transaction | FeeBumpTransaction, publicKey: string): boolean {
  const kp = Keypair.fromPublicKey(publicKey);
  const hint = kp.signatureHint();
  const txHash = tx.hash();
  return tx.signatures.some(
    (ds) => Buffer.from(ds.hint.value).equals(hint) && kp.verify(txHash, Buffer.from(ds.signature.value)),
  );
}

/** Re-parses a transaction from its envelope so signing never mutates the caller's object. */
export function cloneTransaction(tx: Transaction): Transaction {
  const copy = TransactionBuilder.fromXDR(tx.toXDR(), tx.networkPassphrase);
  if (copy instanceof FeeBumpTransaction) {
    throw new WalletError('UNSUPPORTED', 'expected an inner transaction, got a fee-bump envelope');
  }
  return copy;
}

/**
 * Builds the Soroban authorization preimage for an address-credential entry,
 * exactly as the network (and `authorizeEntry` in stellar-base) does:
 * `ENVELOPE_TYPE_SOROBAN_AUTHORIZATION { networkId, nonce, signatureExpirationLedger, invocation }`.
 */
export function buildAuthEntryPreimage(
  entry: xdr.SorobanAuthorizationEntry,
  networkPassphrase: string,
): xdr.HashIdPreimage {
  const credentials = entry.credentials;
  if (credentials.type !== 'sorobanCredentialsAddress') {
    throw new WalletError('UNSUPPORTED', 'auth entry uses source-account credentials and needs no separate signature');
  }
  const addr = credentials.address;
  return xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
    new xdr.HashIdPreimageSorobanAuthorization({
      networkId: hash(Buffer.from(networkPassphrase)),
      nonce: addr.nonce,
      invocation: entry.rootInvocation,
      signatureExpirationLedger: addr.signatureExpirationLedger,
    }),
  );
}

/** The 32 bytes an auth-entry signer signs: SHA-256 of the preimage XDR. */
export function authEntryPayload(preimage: xdr.HashIdPreimage): Uint8Array {
  return Uint8Array.from(hash(preimage.toXdr()));
}

/** Minimal shape needed to sign an auth entry; satisfied by every `WalletProvider`. */
export interface AuthEntrySigner {
  readonly networkPassphrase: string;
  getAddress(): Promise<string>;
  signAuthEntry(preimage: xdr.HashIdPreimage): Promise<Uint8Array>;
}

/**
 * Signs a Soroban authorization entry with a wallet, setting its expiration
 * ledger. Delegates the XDR assembly to stellar-sdk's `authorizeEntry`, which
 * also re-verifies the signature before returning.
 *
 * Note: buyer and seller calls in the escrow flow use the wallet as the
 * transaction source (source-account credentials), so they only need
 * `signTransaction`. This helper is for flows where the wallet is an address
 * credential inside someone else's transaction.
 */
export async function authorizeEntryWithWallet(
  entry: xdr.SorobanAuthorizationEntry,
  wallet: AuthEntrySigner,
  validUntilLedgerSeq: number,
): Promise<xdr.SorobanAuthorizationEntry> {
  const publicKey = await wallet.getAddress();
  // The `{ signature, publicKey }` callback result is part of stellar-sdk 17's
  // `SigningCallback` type; test/raw-signature.test.ts exercises it end to end.
  return authorizeEntry(
    entry,
    async (preimage: xdr.HashIdPreimage) => ({
      signature: Buffer.from(await wallet.signAuthEntry(preimage)),
      publicKey,
    }),
    validUntilLedgerSeq,
    wallet.networkPassphrase,
  );
}
