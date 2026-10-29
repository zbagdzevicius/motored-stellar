// TrustlessWorkRestClient against a fetch mock: paths, methods, headers and bodies
// per Trustless Work's published v1 single-release API reference. Fields whose
// encoding is not settled by the docs are marked TODO(verify) in src/tw-rest.ts.

import { Keypair } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import { TESTNET, TrustlessWorkApiError, TrustlessWorkRestClient, type OnChainEscrow } from '../src/index.js';

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function mockFetch(responder: (c: Captured) => { status?: number; json: unknown }) {
  const calls: Captured[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const c: Captured = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(c);
    const r = responder(c);
    return new Response(JSON.stringify(r.json), { status: r.status ?? 201, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const G = () => Keypair.random().publicKey();
const ESCROW_ID = 'CC3FOQA55L7ZJI6L3IDCSARERTLGJMWTEFQCQX7MTUUODTLESA3T2ZTK';
const GUARD = 'CDJ5BNPZII6XPW4UCYYEF4LPOTJY7ZHPY3P6BVRYWZLED2RTFDJVGJ3F';
const ISSUER = 'GB3Q6QDZYTHWT7E5PVS3W7FUT5GVAFC5KSZFFLPU25GO7VTC3NM2ZTVO';
const API_KEY = 'test-api-key-not-real';

function client(responder: Parameters<typeof mockFetch>[0]) {
  const m = mockFetch(responder);
  const c = new TrustlessWorkRestClient({
    baseUrl: TESTNET.trustlessWorkApiBase,
    apiKey: API_KEY,
    trustline: { address: ISSUER, symbol: 'EURC' },
    fetch: m.fetchImpl,
  });
  return { c, calls: m.calls };
}

const unsigned = { json: { status: 'SUCCESS', unsignedTransaction: 'AAAA-unsigned' } };

describe('TrustlessWorkRestClient', () => {
  const buyer = G();
  const seller = G();
  const platform = G();
  const escrow: Omit<OnChainEscrow, 'flags'> = {
    engagementId: 'a1b2c3d4',
    title: 'order',
    description: 'part',
    roles: { approver: buyer, serviceProvider: seller, receiver: seller, platform, releaseSigner: GUARD, disputeResolver: GUARD },
    amount: 1_005_000_000n,
    platformFeeBps: 470,
    milestones: [{ description: 'part delivered', status: 'awaiting delivery', evidence: '', approved: false }],
    trustline: 'CCBFC27MDMJW3N2RPGXWOIDIAN57IE5E4QFY7HCQSSPOBVOOCGOL563R',
    receiverMemo: 0,
  };

  it('deploys with POST /deployer/single-release, x-api-key header and the documented body', async () => {
    const { c, calls } = client(() => unsigned);
    const tx = await c.initialize({ signer: platform, escrow, trustlineSymbol: 'EURC' });
    expect(tx.unsignedXdr).toBe('AAAA-unsigned');
    const call = calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe('https://dev.api.trustlesswork.com/deployer/single-release');
    expect(call.headers['x-api-key']).toBe(API_KEY);
    expect(call.headers['Content-Type']).toBe('application/json');
    expect(call.body).toEqual({
      signer: platform,
      engagementId: 'a1b2c3d4',
      title: 'order',
      description: 'part',
      roles: { approver: buyer, serviceProvider: seller, platformAddress: platform, releaseSigner: GUARD, disputeResolver: GUARD, receiver: seller },
      amount: 100.5,
      platformFee: 4.7,
      milestones: [{ description: 'part delivered' }],
      trustline: { address: ISSUER, symbol: 'EURC' },
    });
  });

  it('builds fund, approve, dispute and release requests', async () => {
    const { c, calls } = client(() => unsigned);
    await c.fund({ contractId: ESCROW_ID, signer: buyer, amount: 1_005_000_000n });
    await c.approve({ contractId: ESCROW_ID, milestoneIndex: 0, approver: buyer });
    await c.changeDisputeFlag({ contractId: ESCROW_ID, signer: platform });
    await c.release({ contractId: ESCROW_ID, releaseSigner: GUARD });
    expect(calls.map((x) => [x.method, new URL(x.url).pathname, x.body])).toEqual([
      ['POST', '/escrow/single-release/fund-escrow', { contractId: ESCROW_ID, signer: buyer, amount: 100.5 }],
      ['POST', '/escrow/single-release/approve-milestone', { contractId: ESCROW_ID, milestoneIndex: '0', approver: buyer }],
      ['POST', '/escrow/single-release/dispute-escrow', { contractId: ESCROW_ID, signer: platform }],
      ['POST', '/escrow/single-release/release-funds', { contractId: ESCROW_ID, releaseSigner: GUARD }],
    ]);
  });

  it('sends resolutions as address/amount pairs', async () => {
    const { c, calls } = client(() => unsigned);
    await c.resolve({ contractId: ESCROW_ID, disputeResolver: GUARD, distributions: [[buyer, 1_000_000_000n], [seller, 5_000_000n]] });
    expect(calls[0]!.body).toEqual({
      contractId: ESCROW_ID,
      disputeResolver: GUARD,
      distributions: [
        { address: buyer, amount: 100 },
        { address: seller, amount: 0.5 },
      ],
    });
  });

  it('updates with PUT /escrow/single-release/update-escrow', async () => {
    const { c, calls } = client(() => ({ status: 200, json: { status: 'SUCCESS', unsignedTransaction: 'AAAA-upd' } }));
    await c.updateEscrow({
      contractId: ESCROW_ID,
      signer: platform,
      escrow: { ...escrow, title: 'cancelled:1', flags: { disputed: false, released: false, resolved: false } },
    });
    const call = calls[0]!;
    expect(call.method).toBe('PUT');
    expect(new URL(call.url).pathname).toBe('/escrow/single-release/update-escrow');
    expect(call.body).toMatchObject({
      signer: platform,
      contractId: ESCROW_ID,
      escrow: { title: 'cancelled:1', isActive: true, receiverMemo: 0, platformFee: 4.7, flags: { disputed: false, released: false, resolved: false } },
    });
  });

  it('reads an escrow through the indexer with on-chain validation', async () => {
    const { c, calls } = client(() => ({
      status: 200,
      json: [
        {
          contractId: ESCROW_ID,
          engagementId: 'a1b2c3d4',
          title: 'order',
          description: 'part',
          roles: { approver: buyer, serviceProvider: seller, platformAddress: platform, releaseSigner: GUARD, disputeResolver: GUARD, receiver: seller },
          amount: 100.5,
          platformFee: 4.7,
          balance: 100.5,
          milestones: [{ description: 'part delivered', status: 'awaiting delivery', approved: false }],
          flags: { disputed: false, released: false, resolved: false },
          trustline: { address: ISSUER, symbol: 'EURC' },
        },
      ],
    }));
    const snap = await c.getEscrow(ESCROW_ID);
    const url = new URL(calls[0]!.url);
    expect(calls[0]!.method).toBe('GET');
    expect(url.pathname).toBe('/helper/get-escrow-by-contract-ids');
    expect(url.searchParams.get('contractIds')).toBe(ESCROW_ID);
    expect(url.searchParams.get('validateOnChain')).toBe('true');
    expect(snap).toMatchObject({ contractId: ESCROW_ID, amount: 1_005_000_000n, balance: 1_005_000_000n, platformFeeBps: 470 });
    expect(snap.roles.platform).toBe(platform);
  });

  it('submits a signed envelope with POST /helper/send-transaction', async () => {
    const { c, calls } = client(() => ({ status: 200, json: { status: 'SUCCESS', message: 'ok' } }));
    const r = await c.sendTransaction('AAAA-signed');
    expect(new URL(calls[0]!.url).pathname).toBe('/helper/send-transaction');
    expect(calls[0]!.body).toEqual({ signedXdr: 'AAAA-signed' });
    expect(r).toMatchObject({ status: 'SUCCESS', message: 'ok' });
  });

  it('raises TrustlessWorkApiError on HTTP errors without leaking the key', async () => {
    const { c } = client(() => ({ status: 500, json: { message: 'The provided escrow properties do not match the stored escrow' } }));
    const err = await c.fund({ contractId: ESCROW_ID, signer: buyer, amount: 1n }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TrustlessWorkApiError);
    expect((err as TrustlessWorkApiError).status).toBe(500);
    expect(String((err as Error).message)).not.toContain(API_KEY);
  });

  it('refuses to start without an API key', () => {
    expect(() => new TrustlessWorkRestClient({ baseUrl: TESTNET.trustlessWorkApiBase, apiKey: '', trustline: { address: ISSUER, symbol: 'EURC' } })).toThrow();
  });
});
