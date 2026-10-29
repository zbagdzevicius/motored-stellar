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
  xdr,
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
import { NET, entryFor, naclRawSign, sampleInvocation, sorobanTxFrom, sponsoredCreateTx } from './helpers.js';

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

    expect(Buffer.from(ds.hint.value).equals(rawPk.subarray(28))).toBe(true);
    expect(Buffer.from(ds.hint.value).equals(user.signatureHint())).toBe(true);
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
    const seed = await authorizeInvocation({ signer: user, validUntilLedgerSeq: 1_000, invocation: sampleInvocation(), publicKey: user.publicKey(), networkPassphrase: NET, authV2: false });
    const wallet = new RawHashWallet({
      address: user.publicKey(),
      signRawHash: async ({ hash: h }) => naclRawSign(user, h),
    });

    const entry = await authorizeEntryWithWallet(seed, wallet, 5_000);
    const creds = xdr.expectUnionVariant(entry.credentials, 'sorobanCredentialsAddress').address;
    expect(creds.signatureExpirationLedger).toBe(5_000);

    const payload = authEntryPayload(buildAuthEntryPreimage(entry, NET));
    const [sig] = scValToNative(creds.signature) as Array<{ public_key: Buffer; signature: Buffer }>;
    expect(sig).toBeDefined();
    expect(StrKey.encodeEd25519PublicKey(Buffer.from(sig!.public_key))).toBe(user.publicKey());
    expect(user.verify(Buffer.from(payload), Buffer.from(sig!.signature))).toBe(true);
    expect(Buffer.from(payload).equals(hash(buildAuthEntryPreimage(entry, NET).toXdr()))).toBe(true);
  });

  it('signs a V2 (CAP-71) entry over the address-bound preimage and keeps it V2', async () => {
    const user = Keypair.random();
    const seed = await entryFor(user.publicKey(), { v2: true });
    expect(seed.credentials.type).toBe('sorobanCredentialsAddressV2');
    const wallet = new RawHashWallet({
      address: user.publicKey(),
      signRawHash: async ({ hash: h }) => naclRawSign(user, h),
    });

    const entry = await authorizeEntryWithWallet(seed, wallet, 6_000);
    expect(entry.credentials.type).toBe('sorobanCredentialsAddressV2');
    const creds = xdr.expectUnionVariant(entry.credentials, 'sorobanCredentialsAddressV2').addressV2;
    expect(creds.signatureExpirationLedger).toBe(6_000);

    const preimage = buildAuthEntryPreimage(entry, NET);
    expect(preimage.type).toBe('envelopeTypeSorobanAuthorizationWithAddress');
    const payload = authEntryPayload(preimage);
    const [sig] = scValToNative(creds.signature) as Array<{ public_key: Buffer; signature: Buffer }>;
    expect(user.verify(Buffer.from(payload), Buffer.from(sig!.signature))).toBe(true);
  });

  it('a V2 signature does not verify as the legacy preimage of the same entry', async () => {
    const user = Keypair.random();
    const v2 = await entryFor(user.publicKey(), { v2: true });
    const legacy = await entryFor(user.publicKey());
    // Same nonce and invocation, legacy credentials: the payloads must differ.
    const c = xdr.expectUnionVariant(v2.credentials, 'sorobanCredentialsAddressV2').addressV2;
    const sameAsLegacy = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(c),
      rootInvocation: v2.rootInvocation,
    });
    expect(legacy.credentials.type).toBe('sorobanCredentialsAddress');
    const p2 = Buffer.from(authEntryPayload(buildAuthEntryPreimage(v2, NET)));
    const p1 = Buffer.from(authEntryPayload(buildAuthEntryPreimage(sameAsLegacy, NET)));
    expect(p2.equals(p1)).toBe(false);
  });

  it('refuses source-account credentials', () => {
    const entry = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
      rootInvocation: sampleInvocation(),
    });
    expect(() => buildAuthEntryPreimage(entry, NET)).toThrow(WalletError);
  });

  it('is rejected when the wallet signs with a key that does not own the address', async () => {
    const user = Keypair.random();
    const seed = await authorizeInvocation({ signer: user, validUntilLedgerSeq: 1_000, invocation: sampleInvocation(), publicKey: user.publicKey(), networkPassphrase: NET, authV2: false });
    const impostor = new KeypairWallet(Keypair.random());
    const lying = { networkPassphrase: NET, getAddress: async () => user.publicKey(), signAuthEntry: impostor.signAuthEntry.bind(impostor) };

    await expect(authorizeEntryWithWallet(seed, lying, 5_000)).rejects.toThrow();
  });
});
