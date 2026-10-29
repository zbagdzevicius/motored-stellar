/**
 * npm run testnet:e2e-claims
 *
 * TESTNET ONLY (refuses any other network, statically and by asking the RPC).
 * The two claim-and-contest flows, against Trustless Work's testnet Wasm with the
 * guard holding release_signer and dispute_resolver (IDs from testnet-state.json):
 *
 *   D. silent buyer: buyer funds and then does nothing. The platform opens a
 *      dispute, a delivery claim is anchored in the claim registry with a
 *      depth-32 Merkle proof, and after the payout delay the resolver pays the
 *      seller through resolve_dispute. The guard's __check_auth verifies the
 *      proof against the registry (ResolveSeller branch).
 *   E. buyer contest: buyer approves, the seller disputes, the buyer calls
 *      `contest` on the guard inside the contest window. After the window the
 *      claimless seller payout is refused (guard Contested=25) and the resolver
 *      refunds the whole balance to the buyer; the platform tops up the two fees.
 *
 * D and E are set up first, then one wait covers both 120 s windows (testnet
 * config; production is 7 days). Refused paths are enforce-mode simulations and
 * are never submitted. The carrier's delivered event comes from a mock oracle:
 * no carrier is contacted and no parcel data exists. Exports the run log
 * (public tx hashes only) to scripts/out/.
 */
import { createHash } from 'node:crypto';
import { claimToFile, type AnchoredClaim } from '../lib/claims.js';
import { consoleOut, isMain, runMain, type Out } from '../lib/cli.js';
import { FileKeyStore, type KeyStore } from '../lib/keystore.js';
import { addr, bytes, distributions, u32 } from '../lib/scval.js';
import { isRefusal, isTx } from '../lib/soroban.js';
import { writeState } from '../lib/state.js';
import { recheckClaim, type RecheckResult } from '../claims/recheck-core.js';
import { RpcGuard, RpcRegistry } from '../claims/rpc-readers.js';
import { AMT, openOrderKit, sleep, type OrderKit } from './order-kit.js';

/** Proof depth for the silent-buyer claim: the registry's maximum. */
export const SILENT_BUYER_PROOF_DEPTH = 32;
/** Extra seconds on top of a window, for ledger close time versus the local clock. */
export const WINDOW_SLACK_S = 15;
/** Retries (10 s apart) when the guard still answers TooEarly after the wait. */
const EARLY_RETRIES = 6;

/** Seconds to sleep so that `deadlines` (local epoch seconds) have all passed, plus slack. */
export function secondsToWait(deadlines: number[], nowS: number, slack = WINDOW_SLACK_S): number {
  if (deadlines.length === 0) return 0;
  return Math.max(0, Math.ceil(Math.max(...deadlines) - nowS + slack));
}

/** True for a refusal carrying the given guard error code. */
export function refusedWith(r: unknown, code: number): boolean {
  return isRefusal(r) && new RegExp(`Error\\(Contract, #${code}\\)`).test(r.refused);
}

const nowS = () => Date.now() / 1000;

export interface SilentBuyerOrder {
  escrow: string;
  claim: AnchoredClaim;
  /** Local time after which the payout delay has passed. */
  readyAt: number;
}

/** D, before the delay: escrow funded, platform dispute, depth-32 claim anchored, early paths refused. */
export async function silentBuyerSetup(k: OrderKit): Promise<SilentBuyerOrder> {
  const { chain, g, fee, keys: K, S } = k;
  const D = await k.newEscrow('D', AMT);
  await k.fund('D', D, AMT);
  await k.register('D (funded_at)', D);
  await k.must('D: platform dispute_escrow (buyer stays silent)', k.PLATFORM, D, 'dispute_escrow', [addr(k.PLATFORM.publicKey())]);
  await k.register('D (records dispute)', D);
  const dist = distributions([[S, AMT]]);
  await k.guarded('D seller payout without a claim (guard NoClaim=8)', D, 'resolve_dispute', [g, fee, dist], K.resolver, { kind: 'Resolve' }, false);
  const claim = await k.anchorClaim('D', D, SILENT_BUYER_PROOF_DEPTH);
  const readyAt = nowS() + k.st.guardConfig.delay;
  await k.guarded('D seller payout before the delay (guard TooEarly=10)', D, 'resolve_dispute', [g, fee, dist], K.resolver, { kind: 'ResolveSeller', claim }, false);
  const tampered = { ...claim, carrierEventRef: createHash('sha256').update(claim.carrierEventRef).digest() };
  await k.guarded('D seller payout with a tampered claim (guard NoClaim=8)', D, 'resolve_dispute', [g, fee, dist], K.resolver, { kind: 'ResolveSeller', claim: tampered }, false);
  chain.note('D registration', await k.registration(D));
  return { escrow: D, claim, readyAt };
}

/** D, after the delay: the guard pays the seller against the anchored claim; then the public re-check. */
export async function silentBuyerPayout(k: OrderKit, d: SilentBuyerOrder): Promise<{ landed: boolean; check: RecheckResult }> {
  const { chain, g, fee, keys: K, S } = k;
  const dist = distributions([[S, AMT]]);
  const s0 = await k.bal(S);
  let r = await k.guarded('D seller payout against the anchored depth-32 claim', d.escrow, 'resolve_dispute', [g, fee, dist], K.resolver, { kind: 'ResolveSeller', claim: d.claim }, true);
  for (let i = 0; i < EARLY_RETRIES && refusedWith(r, 10); i++) {
    await sleep(10);
    r = await k.guarded('D seller payout against the anchored depth-32 claim (retry)', d.escrow, 'resolve_dispute', [g, fee, dist], K.resolver, { kind: 'ResolveSeller', claim: d.claim }, true);
  }
  const landed = isTx(r) && r.status === 'SUCCESS';
  chain.note('D seller received', ((await k.bal(S)) - s0).toString());
  const check = await recheckClaim(d.claim, new RpcRegistry(chain, k.st.registry, k.src), new RpcGuard(chain, k.st.guard, k.src));
  chain.note('D public re-check of the claim', check);
  return { landed, check };
}

export interface ContestOrder {
  escrow: string;
  buyerBefore: bigint;
  /** Local time after which the contest window has closed. */
  windowClosesAt: number;
}

/** E, inside the window: approval and dispute recorded, then the buyer contests on the guard. */
export async function contestSetup(k: OrderKit): Promise<ContestOrder> {
  const { chain, B, S } = k;
  const E = await k.newEscrow('E', AMT);
  const buyerBefore = (await k.bal(B)) - AMT;
  await k.fund('E', E, AMT);
  await k.register('E (funded_at)', E);
  await k.must('E: buyer approve_milestone', k.BUYER, E, 'approve_milestone', [u32(0), addr(B)]);
  await k.register('E (records approval)', E);
  await k.must('E: seller dispute_escrow', k.SELLER, E, 'dispute_escrow', [addr(S)]);
  await k.register('E (records dispute; contest window opens)', E);
  const windowClosesAt = nowS() + k.st.guardConfig.contestWindow;
  const evidence = createHash('sha256').update(`E|buyer evidence|${E}`).digest();
  await k.must('E: buyer contest on the guard (inside the window)', k.BUYER, k.st.guard, 'contest', [addr(E), bytes(evidence)]);
  chain.note('E registration', await k.registration(E));
  return { escrow: E, buyerBefore, windowClosesAt };
}

/** E, after the window: claimless seller payout refused, whole balance refunded to the buyer, fees topped up. */
export async function contestFinish(k: OrderKit, e: ContestOrder): Promise<{ refused: boolean; refunded: boolean }> {
  const { g, fee, keys: K, B, S } = k;
  const sellerTry = await k.guarded('E seller payout after the window, contested (guard Contested=25)', e.escrow, 'resolve_dispute', [g, fee, distributions([[S, AMT]])], K.resolver, { kind: 'Resolve' }, false);
  const balE = await k.bal(e.escrow);
  const r = await k.guarded('E resolve_dispute: whole balance to the buyer', e.escrow, 'resolve_dispute', [g, fee, distributions([[B, balE]])], K.resolver, { kind: 'Resolve' }, true);
  const refunded = isTx(r) && r.status === 'SUCCESS';
  if (refunded) await k.topUp('E', AMT, e.buyerBefore);
  return { refused: refusedWith(sellerTry, 25), refunded };
}

export async function main(_argv: string[] = process.argv.slice(2), store: KeyStore = new FileKeyStore(), out: Out = consoleOut): Promise<number> {
  const k = await openOrderKit(store, out);
  const { chain, st } = k;
  out.log(`\n#### e2e-claims ${new Date().toISOString()} guard=${st.guard} registry=${st.registry} sac=${st.sac} tw=${st.twDeployer}`);

  const d = await silentBuyerSetup(k);
  const e = await contestSetup(k);

  const wait = secondsToWait([d.readyAt, e.windowClosesAt], nowS());
  chain.note(`waiting ${wait} s (testnet delay ${st.guardConfig.delay} s, contest window ${st.guardConfig.contestWindow} s; production 7 days)`);
  await sleep(wait);

  const dr = await silentBuyerPayout(k, d);
  const er = await contestFinish(k, e);

  writeState({ ...st, claims: [...(st.claims ?? []), claimToFile(d.claim, 'testnet', st.registry)] });
  const logPath = k.exportLog('e2e-claims');
  const ok = dr.landed && dr.check.ok && er.refused && er.refunded;
  chain.note('summary', { silentBuyerPayoutLanded: dr.landed, claimRecheckOk: dr.check.ok, contestBlockedSellerPayout: er.refused, buyerRefunded: er.refunded });
  out.log(`#### ${ok ? 'done' : 'INCOMPLETE'}; run log ${logPath}`);
  return ok ? 0 : 2;
}

if (isMain(import.meta.url)) runMain(() => main());
