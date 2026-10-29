/**
 * Shared order steps for the testnet e2e scripts (e2e.ts and e2e-claims.ts).
 *
 * TESTNET ONLY: `openOrderKit` checks the network statically and by asking the
 * RPC before anything is signed. Keys come from the KeyStore and contract IDs
 * from testnet-state.json. Nothing here prints a secret.
 *
 * Ported from the closures in the first e2e.ts (architect/testnet/arch.mjs and
 * architect/testnet-v08/arch8.mjs); the refund top-up follows flows-money/tn4.sh.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Asset, Keypair, Operation, scValToNative, type xdr } from '@stellar/stellar-sdk';
import { buildTree, claimLeaf, deepenProof, parcelsCommitment, proofOf, rootOf, type AnchoredClaim, type DeliveryClaim } from '../lib/claims.js';
import type { Out } from '../lib/cli.js';
import { accountKeypair, guardKeypair, requireKeys, type KeyStore } from '../lib/keystore.js';
import { assertTestnetLive, testnetConfig } from '../lib/network.js';
import { OUT_DIR } from '../lib/paths.js';
import { addr, bytes, i128, sym, u64, vec } from '../lib/scval.js';
import { Chain, isTx, type GuardBranch } from '../lib/soroban.js';
import { readState, type TestnetState } from '../lib/state.js';
import { escrowValue } from '../lib/tw.js';

/** 100 XEUR in 7-decimal units. */
export const AMT = 1_000_000_000n;
/** Claims are anchored in fixed-size batches so roots do not reveal volume. */
export const CLAIM_BATCH_SIZE = 8;

/** Port: the carrier's delivered event, already authenticated by the platform. */
export interface DeliveredEvent {
  /** Carrier parcel number. Stays off-chain; only its salted HMAC is published. */
  parcelNumber: string;
  /** sha256 of the carrier's authenticated event (see docs/leaf-format.md). */
  carrierEventRef: Buffer;
  deliveredAt: bigint;
}
export interface DeliveryOracle {
  delivered(orderRef: Buffer): Promise<DeliveredEvent>;
}

/** Mock oracle: a synthetic parcel delivered "now". No carrier is contacted. */
export class MockDeliveryOracle implements DeliveryOracle {
  async delivered(orderRef: Buffer): Promise<DeliveredEvent> {
    const parcelNumber = `DEMO-${orderRef.subarray(0, 6).toString('hex').toUpperCase()}`;
    const deliveredAt = BigInt(Math.floor(Date.now() / 1000));
    const carrierEventRef = createHash('sha256').update(`${parcelNumber}|delivered|${deliveredAt}|mock`).digest();
    return { parcelNumber, carrierEventRef, deliveredAt };
  }
}

/** 7-decimal units -> the decimal string classic payments take. */
export function toAmountString(units: bigint): string {
  if (units < 0n) throw new Error('negative amount');
  const s = units.toString().padStart(8, '0');
  const whole = s.slice(0, -7);
  const frac = s.slice(-7).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

export const sleep = (seconds: number): Promise<void> => new Promise((ok) => setTimeout(ok, seconds * 1000));

export type OrderKit = Awaited<ReturnType<typeof openOrderKit>>;

export async function openOrderKit(store: KeyStore, out: Out) {
  const cfg = testnetConfig(process.env.MS_TESTNET_RPC);
  const chain = new Chain(cfg, out.log);
  await assertTestnetLive(chain.server, cfg);
  const keys = requireKeys(store);
  const st: TestnetState = readState();

  const SUB = accountKeypair(keys, 'sponsor');
  const BUYER = accountKeypair(keys, 'buyer');
  const SELLER = accountKeypair(keys, 'seller');
  const PLATFORM = accountKeypair(keys, 'platform');
  const K = { release: guardKeypair(keys, 'release'), resolver: guardKeypair(keys, 'resolver'), breakglass: guardKeypair(keys, 'breakglass') };
  const B = BUYER.publicKey();
  const S = SELLER.publicKey();
  const fee = addr(keys.accounts.twFee.publicKey);
  const wrongFee = addr(keys.accounts.third.publicKey);
  const g = addr(st.guard);
  const asset = new Asset(st.asset.code, st.asset.issuer);
  const oracle: DeliveryOracle = new MockDeliveryOracle();
  const src = SUB.publicKey();
  const bal = (a: string) => chain.balance(st.sac, a, src);

  async function newEscrow(label: string, amount: bigint): Promise<string> {
    const r = await chain.invoke(`${label}: atomic deploy+init via Trustless Work deployer`, SUB, st.twDeployer, 'tw_new_single_release_escrow', [
      addr(SUB.publicKey()),
      bytes(Buffer.from(st.twWasmHash, 'hex')),
      bytes(randomBytes(32)),
      sym('initialize_escrow'),
      vec([escrowValue({ amount, platformFeeBps: st.guardConfig.platformFeeBps, token: st.sac,
        roles: { approver: B, serviceProvider: S, receiver: S, platform: PLATFORM.publicKey(), releaseSigner: st.guard, disputeResolver: st.guard } })]),
      vec([]),
    ]);
    if (!isTx(r) || r.status !== 'SUCCESS' || !r.returnValue) throw new Error(`${label}: escrow deploy failed`);
    const E = (scValToNative(r.returnValue) as [string, unknown])[0];
    chain.note(`${label} escrow = ${E}`);
    const pc = await chain.read(st.guard, 'check_escrow', [addr(E)], src);
    chain.note(`guard.check_escrow(${label}) before funding:`, 'error' in pc ? pc : 'Ok');
    if ('error' in pc) throw new Error(`${label}: guard precheck refused the escrow`);
    return E;
  }

  /** A call that must land; throws on a refusal or a failed transaction so a run never reports a step it did not make. */
  async function must(label: string, signer: Keypair, contract: string, fn: string, args: xdr.ScVal[]) {
    const r = await chain.invoke(label, signer, contract, fn, args);
    if (!isTx(r) || r.status !== 'SUCCESS') throw new Error(`${label}: did not land (${isTx(r) ? r.status : r.refused})`);
    return r;
  }

  async function fund(label: string, E: string, amount: bigint): Promise<void> {
    const exp = await chain.read(E, 'get_escrow', [], src);
    if ('error' in exp) throw new Error(`${label}: get_escrow ${exp.error}`);
    await chain.invoke(`${label}: buyer fund_escrow ${amount}`, BUYER, E, 'fund_escrow', [addr(B), exp.val, i128(amount)]);
  }
  const register = (label: string, E: string) => chain.invoke(`${label}: register_escrow`, SUB, st.guard, 'register_escrow', [addr(E)]);
  const guarded = (label: string, E: string, fn: string, args: xdr.ScVal[], key: Keypair, branch: GuardBranch, submit: boolean) =>
    chain.guarded(label, SUB, E, fn, args, key, branch, submit);

  /** The guard's per-escrow record, as plain values. */
  async function registration(E: string): Promise<Record<string, unknown> | null> {
    const r = await chain.read(st.guard, 'registration', [addr(E)], src);
    if ('error' in r) throw new Error(`registration(${E}): ${r.error}`);
    return (scValToNative(r.val) as Record<string, unknown> | null) ?? null;
  }

  /**
   * Builds this order's claim into a fixed-size batch and anchors the root.
   * With `depth` above the batch depth, the batch sits under random filler
   * siblings (see deepenProof) so the guard walks a proof of that depth.
   */
  async function anchorClaim(label: string, E: string, depth?: number): Promise<AnchoredClaim> {
    const orderRef = randomBytes(32);
    const ev = await oracle.delivered(orderRef);
    const salt = randomBytes(32); // per-order secret; never published
    const c: DeliveryClaim = { orderRef, parcelsCommit: parcelsCommitment(salt, ev.parcelNumber), carrierEventRef: ev.carrierEventRef, deliveredAt: ev.deliveredAt };
    const index = 0;
    const levels = buildTree([claimLeaf(E, c)], CLAIM_BATCH_SIZE);
    const { proof, root } = depth === undefined ? { proof: proofOf(levels, index), root: rootOf(levels) } : deepenProof(levels, index, depth, () => randomBytes(32));
    const batchId = BigInt(Date.now());
    await must(`${label}: anchor claim batch ${batchId} (proof depth ${proof.length})`, SUB, st.registry, 'anchor', [u64(batchId), bytes(root)]);
    chain.note(`${label} batch root`, root.toString('hex'));
    return { ...c, escrow: E, batchId, index, proof };
  }

  /** Refund top-up: the platform pays back exactly what the escrow's two fees took. */
  async function topUp(label: string, paid: bigint, buyerBefore: bigint): Promise<void> {
    const received = (await bal(B)) - buyerBefore;
    const top = paid - received;
    chain.note(`${label} buyer received ${received} of ${paid}; top-up ${top}`);
    if (top > 0n) await chain.classic(`${label}: platform refund top-up ${top}`, PLATFORM, [Operation.payment({ destination: B, asset, amount: toAmountString(top) })]);
    chain.note(`${label} buyer net after top-up`, ((await bal(B)) - buyerBefore).toString());
  }

  /** Writes the run log (public tx hashes only) to scripts/out/. */
  function exportLog(prefix: string): string {
    mkdirSync(OUT_DIR, { recursive: true });
    const logPath = resolve(OUT_DIR, `${prefix}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    writeFileSync(logPath, JSON.stringify({ network: 'testnet', guard: st.guard, registry: st.registry, sac: st.sac, runLog: chain.runLog }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2) + '\n');
    return logPath;
  }

  return {
    chain, st, src, keys: K, SUB, BUYER, SELLER, PLATFORM, B, S, fee, wrongFee, g,
    bal, newEscrow, must, fund, register, guarded, registration, anchorClaim, topUp, exportLog,
  };
}
