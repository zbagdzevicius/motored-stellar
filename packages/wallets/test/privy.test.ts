import { Buffer } from 'buffer';
import { describe, expect, it, vi } from 'vitest';
import { Keypair } from '@stellar/stellar-sdk';

import {
  EmbeddedWalletService,
  InMemoryPrivyClient,
  type PrivyClient,
  PrivyRestClient,
  PrivyWalletProvider,
  type WalletSubject,
  hasValidSignatureFrom,
} from '../src/index.js';
import { NET, naclRawSign, sorobanTxFrom } from './helpers.js';

const BUYER: WalletSubject = { privyUserId: 'did:privy:buyer-1', role: 'buyer' };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('PrivyRestClient', () => {
  // Placeholder credentials for the request-shape test only.
  const config = { appId: 'test-app-id', appSecret: 'test-app-secret' };

  it('POSTs /v1/wallets with Basic auth, the privy-app-id header and a user-owned stellar body', async () => {
    const address = Keypair.random().publicKey();
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, {
        id: 'wallet-1',
        address,
        chain_type: 'stellar',
        owner_id: 'quorum-1',
        additional_signers: [],
        policy_ids: [],
      }),
    );
    const client = new PrivyRestClient({ ...config, fetch: fetchMock as unknown as typeof fetch });

    const wallet = await client.createWallet({ chainType: 'stellar', ownerUserId: BUYER.privyUserId, idempotencyKey: 'k-1' });

    expect(wallet).toEqual({ id: 'wallet-1', address, chainType: 'stellar', ownerId: 'quorum-1', additionalSigners: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.privy.io/v1/wallets');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${Buffer.from('test-app-id:test-app-secret').toString('base64')}`);
    expect(headers['privy-app-id']).toBe('test-app-id');
    expect(headers['Content-Type']).toBe('application/json');
    // No additional signers and no authorisation-key owner are ever requested.
    expect(JSON.parse(String(init.body))).toEqual({
      chain_type: 'stellar',
      owner: { user_id: BUYER.privyUserId },
      idempotency_key: 'k-1',
    });
  });

  it('surfaces HTTP errors as PROVIDER_ERROR without echoing the response body', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(401, { error: 'secret-ish detail' }));
    const client = new PrivyRestClient({ ...config, fetch: fetchMock as unknown as typeof fetch });

    const err = await client.createWallet({ chainType: 'stellar', ownerUserId: 'u' }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'PROVIDER_ERROR' });
    expect(String((err as Error).message)).not.toContain('secret-ish');
  });

  it('requires credentials to be injected', () => {
    expect(() => new PrivyRestClient({ appId: '', appSecret: '' })).toThrow();
  });
});

describe('EmbeddedWalletService', () => {
  it('does not call Privy when the eligibility predicate refuses', async () => {
    const client: PrivyClient = { createWallet: vi.fn() };
    const service = new EmbeddedWalletService({
      client,
      isEligible: (s) => ({ allowed: s.role === 'buyer', reason: 'seller verification incomplete' }),
    });

    await expect(service.createForUser({ privyUserId: 'did:privy:s', role: 'seller' })).rejects.toMatchObject({
      code: 'NOT_ELIGIBLE',
    });
    expect(client.createWallet).not.toHaveBeenCalled();
  });

  it('passes the predicate the subject and creates a stellar wallet owned by that user', async () => {
    const isEligible = vi.fn(async () => true);
    const privy = new InMemoryPrivyClient();
    const service = new EmbeddedWalletService({ client: privy, isEligible });

    const wallet = await service.createForUser(BUYER);
    expect(isEligible).toHaveBeenCalledWith(BUYER);
    expect(wallet.chainType).toBe('stellar');
    expect(wallet.additionalSigners).toEqual([]);

    // Idempotent per owner.
    expect((await service.createForUser(BUYER)).address).toBe(wallet.address);
  });

  it.each([
    ['a non-stellar wallet', { chainType: 'ethereum' }],
    ['an invalid address', { address: '0xabc' }],
    ['additional signers', { additionalSigners: [{ signer_id: 'q' }] }],
    ['no id', { id: '' }],
  ])('rejects a Privy response with %s', async (_label, override) => {
    const good = { id: 'w', address: Keypair.random().publicKey(), chainType: 'stellar', ownerId: null, additionalSigners: [] };
    const client: PrivyClient = { createWallet: async () => ({ ...good, ...override }) };
    const service = new EmbeddedWalletService({ client, isEligible: () => true });
    await expect(service.createForUser(BUYER)).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  });
});

describe('PrivyWalletProvider', () => {
  it('calls signRawHash with the address, chainType stellar and the 0x tx hash, then attaches a valid signature', async () => {
    const user = Keypair.random();
    const signRawHash = vi.fn(async ({ hash }: { address: string; chainType: 'stellar'; hash: `0x${string}` }) => ({
      signature: naclRawSign(user, hash),
    }));
    const wallet = new PrivyWalletProvider({ address: user.publicKey(), signRawHash, networkPassphrase: NET });
    const tx = sorobanTxFrom(user.publicKey());

    const signed = await wallet.signTransaction(tx);

    expect(signRawHash).toHaveBeenCalledWith({
      address: user.publicKey(),
      chainType: 'stellar',
      hash: `0x${Buffer.from(tx.hash()).toString('hex')}`,
    });
    expect(hasValidSignatureFrom(signed, user.publicKey())).toBe(true);
  });

  it('rejects a signature Privy produced with a different key', async () => {
    const user = Keypair.random();
    const other = Keypair.random();
    const wallet = new PrivyWalletProvider({
      address: user.publicKey(),
      signRawHash: async ({ hash }) => ({ signature: naclRawSign(other, hash) }),
    });
    await expect(wallet.signTransaction(sorobanTxFrom(user.publicKey()))).rejects.toMatchObject({
      code: 'BAD_SIGNATURE',
    });
  });

  it('rejects an empty Privy response', async () => {
    const user = Keypair.random();
    const wallet = new PrivyWalletProvider({
      address: user.publicKey(),
      signRawHash: async () => ({}) as { signature: string },
    });
    await expect(wallet.signTransaction(sorobanTxFrom(user.publicKey()))).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
    });
  });

  it('an in-memory Privy session cannot sign for another user', async () => {
    const privy = new InMemoryPrivyClient();
    const a = await privy.createWallet({ chainType: 'stellar', ownerUserId: 'did:privy:a' });
    await privy.createWallet({ chainType: 'stellar', ownerUserId: 'did:privy:b' });
    const wallet = new PrivyWalletProvider({ address: a.address, signRawHash: privy.signRawHashFor('did:privy:b') });

    await expect(wallet.signTransaction(sorobanTxFrom(a.address))).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  });
});
