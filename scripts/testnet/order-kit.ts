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

/** 100 XEUR in 7-decimal units: the order amount when neither `--amount` nor testnet-state.json sets one. */
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

/** Decimal string (up to 7 places, as classic assets use) -> 7-decimal units. Rejects zero, negatives and excess precision. */
export function parseAmount(v: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,7}))?$/.exec(v.trim());
  if (!m) throw new Error(`amount must be a positive decimal with at most 7 places, got ${v}`);
  const units = BigInt(m[1]!) * 10_000_000n + BigInt((m[2] ?? '').padEnd(7, '0') || '0');
  if (units <= 0n) throw new Error(`amount must be above zero, got ${v}`);
  return units;
}

/**
 * The buyer balance a script needs, in multiples of the order amount, and what it
 * spends for good (seller payouts). Refunds come back whole once the platform has
 * topped up the two fees; without a top-up the buyer is also short about 5% of each
 * refunded amount, which the 1.1x margin in `buyerNeed` covers.
 *   e2e:         A released, then B (1x) and C (0.4x) refunded -> holds 2x, spends 1x (+1x with --silent-buyer)
 *   e2e-claims:  D and E funded together, D paid to the seller, E refunded -> holds 2x, spends 1x
 *   refusals:    A released, B, C, E refunded one at a time -> holds 2x, spends 1x
 */
export const BUYER_BUDGET = {
  e2e: { hold: 2n, spend: 1n },
  'e2e --silent-buyer': { hold: 3n, spend: 2n },
  'e2e-claims': { hold: 2n, spend: 1n },
  refusals: { hold: 2n, spend: 1n },
} as const;
export type ScriptName = keyof typeof BUYER_BUDGET;

/** Minimum buyer balance (units) to start `script` at order amount `amt`: the peak holding plus a 10% fee margin. */
export function buyerNeed(script: ScriptName, amt: bigint): bigint {
  return (BUYER_BUDGET[script].hold * amt * 11n) / 10n;
}

export const sleep = (seconds: number): Promise<void> => new Promise((ok) => setTimeout(ok, seconds * 1000));

export type OrderKit = Awaited<ReturnType<typeof openOrderKit>>;

export interface OrderKitOptions {
  /** Per-order amount as a decimal string (`--amount`); default: testnet-state.json's orderAmount, else 100. */
  amount?: string;
  /** Which script is running, for the buyer balance check before anything is signed. */
  script?: ScriptName;
}

export async function openOrderKit(store: KeyStore, out: Out, opts: OrderKitOptions = {}) {
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
  const amountArg = opts.amount ?? st.orderAmount;
  const amt = amountArg === undefined ? AMT : parseAmount(amountArg);
  const unit = st.asset.code;
  chain.note(`order amount ${toAmountString(amt)} ${unit} (${amt} units)`);

  if (opts.script) {
    const need = buyerNeed(opts.script, amt);
    const have = await bal(B);
    chain.note(`buyer holds ${toAmountString(have)} ${unit}; ${opts.script} needs at least ${toAmountString(need)} ${unit}`);
    if (have < need) {
      throw new Error(`buyer ${B} holds ${toAmountString(have)} ${unit}, ${opts.script} needs ${toAmountString(need)} at --amount ${toAmountString(amt)}; ` +
        (st.asset.external ? 'fund it from https://faucet.circle.com (Stellar testnet, EURC) or lower --amount' : 'redeploy or lower --amount'));
    }
  }
  // The stand-in deploy gives `third` (the wrong fee address in negative checks) a dust balance; with an
  // external asset nothing is issued, so the buyer sends the same dust once.
  if (st.asset.external && (await bal(keys.accounts.third.publicKey)) === 0n) {
    await chain.classic('third: buyer sends 0.0001 dust (as the stand-in deploy does)', BUYER, [Operation.payment({ destination: keys.accounts.third.publicKey, asset, amount: '0.0001' })]);
  }

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

  /**
   * Refund top-up: the platform pays back exactly what the escrow's two fees took.
   * With an external asset the platform holds only its fee income (plus any faucet
   * drip); when that is short, the top-up is skipped and logged instead of failing
   * the run. Returns whether the buyer ended up whole.
   */
  async function topUp(label: string, paid: bigint, buyerBefore: bigint): Promise<boolean> {
    const received = (await bal(B)) - buyerBefore;
    const top = paid - received;
    chain.note(`${label} buyer received ${received} of ${paid}; top-up ${top}`);
    if (top <= 0n) return true;
    const platformHas = await bal(PLATFORM.publicKey());
    if (platformHas < top) {
      chain.note(`${label}: refund top-up SKIPPED, platform holds ${toAmountString(platformHas)} ${unit}, needs ${toAmountString(top)}`);
      return false;
    }
    await chain.classic(`${label}: platform refund top-up ${top}`, PLATFORM, [Operation.payment({ destination: B, asset, amount: toAmountString(top) })]);
    const net = (await bal(B)) - buyerBefore;
    chain.note(`${label} buyer net after top-up`, net.toString());
    return net === paid;
  }

  /** Writes the run log (public tx hashes only) to scripts/out/. */
  function exportLog(prefix: string): string {
    mkdirSync(OUT_DIR, { recursive: true });
    const logPath = resolve(OUT_DIR, `${prefix}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    writeFileSync(logPath, JSON.stringify({ network: 'testnet', asset: `${st.asset.code}:${st.asset.issuer}`, orderAmount: toAmountString(amt), guard: st.guard, registry: st.registry, sac: st.sac, runLog: chain.runLog }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2) + '\n');
    return logPath;
  }

  return {
    chain, st, src, amt, keys: K, SUB, BUYER, SELLER, PLATFORM, B, S, fee, wrongFee, g,
    bal, newEscrow, must, fund, register, guarded, registration, anchorClaim, topUp, exportLog,
  };
}
