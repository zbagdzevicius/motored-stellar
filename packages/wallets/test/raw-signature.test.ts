import { Buffer } from 'buffer';
import { describe, expect, it } from 'vitest';
import {
  Keypair,
  StrKey,
  Transaction,
  TransactionBuilder,
  authorizeInvocation,
  hash,
  scValToNative,
} from '@stellar/stellar-sdk';

import {
  KeypairWallet,
  RawHashWallet,
  WalletError,
  attachRawSignature,
  authEntryPayload,
  authorizeEntryWithWallet,
  buildAuthEntryPreimage,
  decoratedSignatureFromRaw,
  hasValidSignatureFrom,
  hexToBytes,
  transactionHashHex,
  verifyRawSignature,
} from '../src/index.js';
import { NET, naclRawSign, sampleInvocation, sorobanTxFrom, sponsoredCreateTx } from './helpers.js';

describe('raw-hash signing -> DecoratedSignature', () => {
  it('produces a signature that Keypair.verify accepts over the tx hash', () => {
    const user = Keypair.random();
    const tx = sorobanTxFrom(user.publicKey());
    const sig = hexToBytes(naclRawSign(user, transactionHashHex(tx)));

    expect(sig).toHaveLength(64);
    expect(user.verify(tx.hash(), Buffer.from(sig))).toBe(true);
    expect(verifyRawSignature(user.publicKey(), tx.hash(), sig)).toBe(true);
  });

  it('uses the last 4 bytes of the raw public key as the hint', () => {
    const user = Keypair.random();
    const ds = decoratedSignatureFromRaw(user.publicKey(), new Uint8Array(64));
    const rawPk = StrKey.decodeEd25519PublicKey(user.publicKey());

    expect(Buffer.from(ds.hint()).equals(rawPk.subarray(28))).toBe(true);
    expect(Buffer.from(ds.hint()).equals(user.signatureHint())).toBe(true);
  });

  it('attaches a signature identical to tx.sign(keypair) and survives an XDR round trip', () => {
    const user = Keypair.random();
    const viaRaw = sorobanTxFrom(user.publicKey());
    const viaSdk = sorobanTxFrom(user.publicKey());

    attachRawSignature(viaRaw, user.publicKey(), naclRawSign(user, transactionHashHex(viaRaw)));
    viaSdk.sign(user);

    expect(viaRaw.toXDR()).toBe(viaSdk.toXDR());
    const reparsed = TransactionBuilder.fromXDR(viaRaw.toXDR(), NET) as Transaction;
    expect(hasValidSignatureFrom(reparsed, user.publicKey())).toBe(true);
  });

  it('refuses a signature from the wrong key, over the wrong payload, or of the wrong length', () => {
    const user = Keypair.random();
    const other = Keypair.random();
    const tx = sorobanTxFrom(user.publicKey());

    const wrongKey = naclRawSign(other, transactionHashHex(tx));
    expect(() => attachRawSignature(tx, user.publicKey(), wrongKey)).toThrow(WalletError);

    const wrongPayload = naclRawSign(user, `0x${'11'.repeat(32)}`);
    expect(() => attachRawSignature(tx, user.publicKey(), wrongPayload)).toThrow(/does not verify/);

    expect(() => attachRawSignature(tx, user.publicKey(), new Uint8Array(63))).toThrow(WalletError);
    expect(() => attachRawSignature(tx, user.publicKey(), '0xzz')).toThrow(WalletError);
    expect(tx.signatures).toHaveLength(0);
  });

  it('keeps the inner signature valid inside a sponsor fee-bump (lab E2 shape)', () => {
    const user = Keypair.random();
    const sponsor = Keypair.random();
    const inner = sorobanTxFrom(user.publicKey());
    attachRawSignature(inner, user.publicKey(), naclRawSign(user, transactionHashHex(inner)));

    const fb = TransactionBuilder.buildFeeBumpTransaction(sponsor, (BigInt(inner.fee) * 2n).toString(), inner, NET);
    fb.sign(sponsor);

    const reparsed = TransactionBuilder.fromXDR(fb.toXDR(), NET);
    expect('innerTransaction' in reparsed).toBe(true);
    if (!('innerTransaction' in reparsed)) return;
    expect(hasValidSignatureFrom(reparsed.innerTransaction, user.publicKey())).toBe(true);
    expect(hasValidSignatureFrom(reparsed, sponsor.publicKey())).toBe(true);
    expect(hasValidSignatureFrom(reparsed, user.publicKey())).toBe(false);
  });

  it('co-signs a sponsored account creation where the user is only an operation source (lab E1 shape)', async () => {
    const sponsor = Keypair.random();
    const user = Keypair.random();
    const wallet = new RawHashWallet({
      address: user.publicKey(),
      signRawHash: async ({ hash: h }) => naclRawSign(user, h),
    });

    const tx = sponsoredCreateTx(sponsor.publicKey(), user.publicKey());
    tx.sign(sponsor);
    const signed = await wallet.signTransaction(tx);

    expect(signed.signatures).toHaveLength(2);
    expect(hasValidSignatureFrom(signed, sponsor.publicKey())).toBe(true);
    expect(hasValidSignatureFrom(signed, user.publicKey())).toBe(true);
    // The caller's object is untouched.
    expect(tx.signatures).toHaveLength(1);
  });
});

describe('auth-entry signing', () => {
  it('builds the same preimage the network signs and authorizes an entry through a raw-hash wallet', async () => {
    const user = Keypair.random();
    // Start from an entry for the user's address (signed once by the key directly).
    const seed = await authorizeInvocation(user, 1_000, sampleInvocation(), user.publicKey(), NET);
    const wallet = new RawHashWallet({
      address: user.publicKey(),
      signRawHash: async ({ hash: h }) => naclRawSign(user, h),
    });

    const entry = await authorizeEntryWithWallet(seed, wallet, 5_000);
    const creds = entry.credentials().address();
    expect(creds.signatureExpirationLedger()).toBe(5_000);

    const payload = authEntryPayload(buildAuthEntryPreimage(entry, NET));
    const [sig] = scValToNative(creds.signature()) as Array<{ public_key: Buffer; signature: Buffer }>;
    expect(sig).toBeDefined();
    expect(StrKey.encodeEd25519PublicKey(Buffer.from(sig!.public_key))).toBe(user.publicKey());
    expect(user.verify(Buffer.from(payload), Buffer.from(sig!.signature))).toBe(true);
    expect(Buffer.from(payload).equals(hash(buildAuthEntryPreimage(entry, NET).toXDR()))).toBe(true);
  });

  it('is rejected when the wallet signs with a key that does not own the address', async () => {
    const user = Keypair.random();
    const seed = await authorizeInvocation(user, 1_000, sampleInvocation(), user.publicKey(), NET);
    const impostor = new KeypairWallet(Keypair.random());
    const lying = { networkPassphrase: NET, getAddress: async () => user.publicKey(), signAuthEntry: impostor.signAuthEntry.bind(impostor) };

    await expect(authorizeEntryWithWallet(seed, lying, 5_000)).rejects.toThrow();
  });
});
