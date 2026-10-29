// Guard authorization entries and the release service's record -> sign ->
// enforce -> submit path, with an in-memory RPC that plays the guard's
// signature check.

import { createHash } from 'node:crypto';
import { Address, Keypair, Networks, xdr, type Operation } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import {
  addr,
  authorizationPayload,
  claimToScVal,
  deliveryClaimLeaf,
  describeAuthEntry,
  GuardedCallError,
  InMemorySubmitter,
  KeypairSigner,
  ReleaseService,
  rootFromProof,
  signGuardEntries,
  simContractError,
  simOk,
  type DeliveryClaim,
  type SimHandler,
} from '../src/index.js';

const NET = Networks.TESTNET;
const ESCROW = 'CC3FOQA55L7ZJI6L3IDCSARERTLGJMWTEFQCQX7MTUUODTLESA3T2ZTK';
const GUARD = 'CDJ5BNPZII6XPW4UCYYEF4LPOTJY7ZHPY3P6BVRYWZLED2RTFDJVGJ3F';
const TOKEN = 'CCBFC27MDMJW3N2RPGXWOIDIAN57IE5E4QFY7HCQSSPOBVOOCGOL563R';
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest();

/** An unsigned address-credential entry, as record-mode simulation returns it. */
function guardEntry(address: string, contract: string, fn: string, args: xdr.ScVal[], nonce = 7n): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(address).toScAddress(),
        nonce: xdr.Int64.fromString(nonce.toString()),
        signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({ contractAddress: new Address(contract).toScAddress(), functionName: fn, args }),
      ),
      subInvocations: [],
    }),
  });
}

/** Branch name and raw signature out of a signed entry's GuardSig. */
function readGuardSig(e: xdr.SorobanAuthorizationEntry): { branch: string; sig: Buffer; claim?: xdr.ScVal } {
  const v = e.credentials().address().signature().vec();
  if (!v || v.length !== 2) throw new Error('GuardSig must be a 2-element vec');
  const branch = v[0]!.sym().toString();
  if (branch === 'ResolveSeller') {
    const fields = v[1]!.map() ?? [];
    const get = (k: string) => fields.find((f) => f.key().sym().toString() === k)!.val();
    return { branch, sig: get('sig').bytes(), claim: get('claim') };
  }
  return { branch, sig: v[1]!.bytes() };
}

function claim(seed: number, escrow = ESCROW): DeliveryClaim & { root: Buffer } {
  const c: DeliveryClaim = {
    orderRef: Buffer.alloc(32, seed),
    parcelsCommit: Buffer.alloc(32, seed + 1),
    carrierEventRef: Buffer.alloc(32, seed + 2),
    deliveredAt: 1_800_000_000n,
    batchId: 42n,
    proof: [Buffer.alloc(32, 0xaa), Buffer.alloc(32, 0xbb)],
    index: 2,
  };
  return { ...c, root: rootFromProof(deliveryClaimLeaf(escrow, c), c.proof, c.index) };
}

describe('delivery claim leaf and Merkle path', () => {
  it('matches the published leaf layout byte for byte', () => {
    const c = claim(1);
    const be = Buffer.alloc(8);
    be.writeBigUInt64BE(c.deliveredAt);
    const expected = sha(
      Buffer.concat([Buffer.from([1]), new Address(ESCROW).toScVal().toXDR(), c.orderRef, c.parcelsCommit, c.carrierEventRef, be]),
    );
    expect(deliveryClaimLeaf(ESCROW, c).equals(expected)).toBe(true);
  });

  it('binds the leaf to the escrow address', () => {
    const c = claim(1);
    expect(deliveryClaimLeaf(ESCROW, c).equals(deliveryClaimLeaf(GUARD, c))).toBe(false);
  });

  it('hashes nodes as sha256(0x02 || left || right), index bits lowest first', () => {
    const leaf = Buffer.alloc(32, 1);
    const sib = Buffer.alloc(32, 2);
    expect(rootFromProof(leaf, [sib], 0).equals(sha(Buffer.concat([Buffer.from([2]), leaf, sib])))).toBe(true);
    expect(rootFromProof(leaf, [sib], 1).equals(sha(Buffer.concat([Buffer.from([2]), sib, leaf])))).toBe(true);
    expect(() => rootFromProof(leaf, Array.from({ length: 33 }, () => sib), 0)).toThrow();
  });

  it('encodes the Claim struct with carrier_event_ref and sorted keys', () => {
    const keys = (claimToScVal(claim(3)).map() ?? []).map((e) => e.key().sym().toString());
    expect(keys).toEqual(['batch_id', 'carrier_event_ref', 'delivered_at', 'index', 'order_ref', 'parcels_commit', 'proof']);
  });
});

describe('signGuardEntries', () => {
  const release = Keypair.random();
  const args = [addr(GUARD), addr(Keypair.random().publicKey())];

  it('signs the guard entry over the Soroban authorization payload', async () => {
    const [signed] = await signGuardEntries([guardEntry(GUARD, ESCROW, 'release_funds', args)], {
      guardContractId: GUARD,
      networkPassphrase: NET,
      validUntilLedger: 1_234,
      key: new KeypairSigner(release),
      branch: 'Release',
      expect: { contractId: ESCROW, fn: 'release_funds' },
    });
    const creds = signed!.credentials().address();
    expect(creds.signatureExpirationLedger()).toBe(1_234);
    const { branch, sig } = readGuardSig(signed!);
    expect(branch).toBe('Release');
    expect(sig.length).toBe(64);
    const payload = authorizationPayload(signed!, NET);
    expect(Keypair.fromPublicKey(release.publicKey()).verify(payload, sig)).toBe(true);
    // Bound to network, contract and function.
    expect(Keypair.fromPublicKey(release.publicKey()).verify(authorizationPayload(signed!, Networks.PUBLIC), sig)).toBe(false);
    expect(describeAuthEntry(signed!)).toMatchObject({ address: GUARD, contractId: ESCROW, fn: 'release_funds' });
  });

  it('a signature for one escrow does not verify for another', async () => {
    const other = 'CCPOJY5UG2ELCMP5FYG5GSOWMW6QJ47XUVPMEFGQOC4BDF7CAOSMK5KQ';
    const [signed] = await signGuardEntries([guardEntry(GUARD, ESCROW, 'release_funds', args)], {
      guardContractId: GUARD, networkPassphrase: NET, validUntilLedger: 10, key: new KeypairSigner(release), branch: 'Release',
    });
    const forged = guardEntry(GUARD, other, 'release_funds', args);
    forged.credentials().address().signatureExpirationLedger(10);
    expect(Keypair.fromPublicKey(release.publicKey()).verify(authorizationPayload(forged, NET), readGuardSig(signed!).sig)).toBe(false);
  });

  it('leaves other entries untouched and does not mutate its input', async () => {
    const original = guardEntry(GUARD, ESCROW, 'release_funds', args);
    const foreign = guardEntry(Keypair.random().publicKey(), ESCROW, 'release_funds', args);
    const before = original.toXDR('base64');
    const out = await signGuardEntries([original, foreign], {
      guardContractId: GUARD, networkPassphrase: NET, validUntilLedger: 10, key: new KeypairSigner(release), branch: 'Release',
    });
    expect(original.toXDR('base64')).toBe(before);
    expect(out[1]!.toXDR('base64')).toBe(foreign.toXDR('base64'));
  });

  it('refuses when the entry authorizes a different function, or when no guard entry exists', async () => {
    const opts = { guardContractId: GUARD, networkPassphrase: NET, validUntilLedger: 10, key: new KeypairSigner(release), branch: 'Release' as const };
    await expect(signGuardEntries([guardEntry(GUARD, ESCROW, 'resolve_dispute', args)], { ...opts, expect: { contractId: ESCROW, fn: 'release_funds' } })).rejects.toThrow();
    await expect(signGuardEntries([], opts)).rejects.toThrow();
  });

  it('carries the claim in ResolveSeller', async () => {
    const c = claim(9);
    const [signed] = await signGuardEntries([guardEntry(GUARD, ESCROW, 'resolve_dispute', args)], {
      guardContractId: GUARD, networkPassphrase: NET, validUntilLedger: 10, key: KeypairSigner.random(), branch: 'ResolveSeller', claim: c,
    });
    const g = readGuardSig(signed!);
    expect(g.branch).toBe('ResolveSeller');
    expect(g.claim!.toXDR('base64')).toBe(claimToScVal(c).toXDR('base64'));
  });
});

describe('ReleaseService over an in-memory RPC', () => {
  const twFee = Keypair.random().publicKey();
  const keys = { release: Keypair.random(), resolver: Keypair.random(), breakglass: Keypair.random() };

  /** Plays the escrow + guard: record mode returns the guard entry; enforce mode checks the signature. */
  function guardHandler(fn: string, expectKey: Keypair, refuse?: number): SimHandler {
    return (args, tx, mode) => {
      if (mode === 'record') return simOk(undefined, [guardEntry(GUARD, ESCROW, fn, args)]);
      const op = tx.operations[0] as Operation.InvokeHostFunction;
      const entry = op.auth?.[0];
      if (!entry) return { ok: false, error: 'no auth' };
      const ok = expectKey.verify(authorizationPayload(entry, NET), readGuardSig(entry).sig);
      if (!ok) return { ok: false, error: 'HostError: Error(Auth, InvalidAction)' };
      return refuse ? simContractError(refuse) : simOk();
    };
  }

  function service(rpc: InMemorySubmitter, lineage: 'testnet' | 'mainnet' = 'testnet') {
    return new ReleaseService(rpc, {
      networkPassphrase: NET,
      guardContractId: GUARD,
      tokenContractId: TOKEN,
      lineage: lineage === 'testnet' ? { kind: 'fee-address-argument', trustlessWorkFeeAddress: twFee } : { kind: 'hardcoded-fee-account' },
      submitter: KeypairSigner.random(),
      releaseKey: new KeypairSigner(keys.release),
      resolverKey: new KeypairSigner(keys.resolver),
      breakGlassKey: new KeypairSigner(keys.breakglass),
    });
  }

  it('releases with the release key and the testnet fee-address argument', async () => {
    const rpc = new InMemorySubmitter(500).on(ESCROW, 'release_funds', guardHandler('release_funds', keys.release));
    const r = await service(rpc).release(ESCROW);
    expect(r.submit?.status).toBe('SUCCESS');
    expect(rpc.sent).toHaveLength(1);
    expect(rpc.simulated.map((s) => s.authMode)).toEqual(['record', 'enforce']);
    const op = (rpc.sent[0] as unknown as { operations: Operation.InvokeHostFunction[] }).operations[0]!;
    const call = op.func.invokeContract();
    expect(call.args().map((a) => Address.fromScVal(a).toString())).toEqual([GUARD, twFee]);
    expect(op.auth![0]!.credentials().address().signatureExpirationLedger()).toBe(700);
  });

  it('omits the fee-address argument on the hardcoded-fee lineage', () => {
    const s = service(new InMemorySubmitter(), 'mainnet');
    expect(s.releaseArgs()).toHaveLength(1);
    expect(s.distributionArgs([[keys.release.publicKey(), 1n]])).toHaveLength(2);
  });

  it('a release signed with the wrong key fails enforce simulation and is never submitted', async () => {
    const rpc = new InMemorySubmitter().on(ESCROW, 'release_funds', guardHandler('release_funds', keys.resolver));
    const err = await service(rpc).release(ESCROW).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GuardedCallError);
    expect((err as GuardedCallError).stage).toBe('enforce-simulation');
    expect(rpc.sent).toHaveLength(0);
  });

  it('maps a guard refusal to its name (SellerOverAmount = 28)', async () => {
    const rpc = new InMemorySubmitter().on(ESCROW, 'resolve_dispute', guardHandler('resolve_dispute', keys.resolver, 28));
    const seller = Keypair.random().publicKey();
    const err = await service(rpc).resolve(ESCROW, [[seller, 2_000n]], { claim: claim(4) }).catch((e: unknown) => e);
    expect((err as GuardedCallError).guardError).toBe('SellerOverAmount');
    expect(rpc.sent).toHaveLength(0);
  });

  it('break-glass refunds use the break-glass key', async () => {
    const rpc = new InMemorySubmitter().on(ESCROW, 'resolve_dispute', guardHandler('resolve_dispute', keys.breakglass));
    const buyer = Keypair.random().publicKey();
    const r = await service(rpc).resolve(ESCROW, [[buyer, 1_000n]], { branch: 'BreakGlass' });
    expect(r.submit?.status).toBe('SUCCESS');
  });

  it('runs the seller payout gate before a seller resolution', async () => {
    const rpc = new InMemorySubmitter().on(ESCROW, 'resolve_dispute', guardHandler('resolve_dispute', keys.resolver));
    const seller = Keypair.random().publicKey();
    const s = new ReleaseService(rpc, {
      networkPassphrase: NET,
      guardContractId: GUARD,
      tokenContractId: TOKEN,
      lineage: { kind: 'hardcoded-fee-account' },
      submitter: KeypairSigner.random(),
      releaseKey: new KeypairSigner(keys.release),
      resolverKey: new KeypairSigner(keys.resolver),
      sellerPayoutGate: async () => {
        throw new Error('seller not verified');
      },
    });
    await expect(s.resolve(ESCROW, [[seller, 1_000n]], { claim: claim(5), seller })).rejects.toThrow('seller not verified');
    expect(rpc.simulated).toHaveLength(0);
  });
});
