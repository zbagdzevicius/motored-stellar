/**
 * npm run testnet:v010 [-- --amount 2]
 *
 * TESTNET ONLY (refuses any other network, statically and by asking the RPC).
 * The two guard v0.10 rules that runs 4 to 8 (guard v0.9) could not show, against
 * Trustless Work's testnet Wasm with the guard holding release_signer and
 * dispute_resolver (IDs from testnet-state.json, which must name a v0.10 guard):
 *
 *   F. platform fee cap: an escrow whose platform_fee is one basis point above the
 *      guard's `max_platform_fee_bps` fails the precheck, and its `register_escrow`
 *      is landed as a FAILED transaction (guard PlatformFeeOverCap=29), so no guard
 *      branch can ever pay out of it. An escrow at exactly the cap passes the
 *      precheck and registers (it is registered at 1 unit of dust, which stays in it).
 *   W. seller paid alone past a buyer who cannot receive: a throwaway buyer account
 *      funds the escrow, then removes its EURC trustline, and 1 unit of dust is sent
 *      to the escrow. Every resolve_dispute must now sum to the balance and so carry
 *      a buyer leg, which the token refuses. The platform disputes, a delivery claim
 *      is anchored, and after the delay the resolver pays the seller alone through
 *      withdraw_remaining_funds (ResolveSeller branch, v0.10). The registration
 *      closes; the dust stays in the escrow for the buyer.
 *
 * Refused paths other than F's registration are enforce-mode simulations and are
 * never submitted. The throwaway buyer's key is generated in memory, funded by
 * friendbot and never written anywhere. The carrier's delivered event comes from
 * the mock oracle. Exports the run log (public tx hashes only) to scripts/out/.
 */
import { parseArgs } from 'node:util';
import { Keypair, Operation } from '@stellar/stellar-sdk';
import { claimToFile } from '../lib/claims.js';
import { consoleOut, isMain, runMain, type Out } from '../lib/cli.js';
import { fundWithFriendbot } from '../lib/friendbot.js';
import { FileKeyStore, type KeyStore } from '../lib/keystore.js';
import { addr, distributions, i128 } from '../lib/scval.js';
import { isRefusal, isTx, type LandedRefusal, type Refusal } from '../lib/soroban.js';
import { writeState } from '../lib/state.js';
import { recheckClaim } from '../claims/recheck-core.js';
import { RpcGuard, RpcRegistry } from '../claims/rpc-readers.js';
import { DEFAULT_MAX_PLATFORM_FEE_BPS } from './deploy.js';
import { openOrderKit, sleep, toAmountString } from './order-kit.js';
import { refusedWith, secondsToWait } from './e2e-claims.js';
import { summarize } from './refusals.js';

/** Guard PlatformFeeOverCap (v0.10). */
export const PLATFORM_FEE_OVER_CAP = 29;
/** Retries (10 s apart) when the guard still answers TooEarly after the wait. */
const EARLY_RETRIES = 6;

/** The fee rates scenario F uses: one basis point over the cap, and exactly the cap. */
export function feeCapProbe(cap: number): { over: number; at: number } {
  if (!Number.isInteger(cap) || cap < 0 || cap >= 10_000) throw new Error(`cap must be an integer from 0 to 9999 bps, got ${cap}`);
  return { over: cap + 1, at: cap };
}

export async function main(argv: string[] = process.argv.slice(2), store: KeyStore = new FileKeyStore(), out: Out = consoleOut): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { amount: { type: 'string' } } });
  const k = await openOrderKit(store, out, { amount: values.amount, script: 'v010' });
  const { chain, st, src, amt: AMT, keys: K, SUB, BUYER, PLATFORM, B, S, fee, g, asset, unit, bal, newEscrow, fund, register, guarded, registration, anchorClaim, must } = k;
  const cap = st.guardConfig.maxPlatformFeeBps;
  if (cap === undefined) throw new Error('testnet-state.json has no guardConfig.maxPlatformFeeBps: deploy a v0.10 guard first (npm run testnet:deploy)');
  out.log(`\n#### v010 ${new Date().toISOString()} guard=${st.guard} registry=${st.registry} sac=${st.sac} tw=${st.twDeployer} cap=${cap} bps (default ${DEFAULT_MAX_PLATFORM_FEE_BPS})`);
  const ok = (r: unknown) => isTx(r) && r.status === 'SUCCESS';

  // F: the platform fee cap.
  const probe = feeCapProbe(cap);
  const F1 = await newEscrow(`F1 (platform_fee ${probe.over} bps, over the cap)`, AMT, { platformFeeBps: probe.over, precheckMustPass: false });
  const f1: LandedRefusal | Refusal = await chain.landFailingCall(`F1 register_escrow above the fee cap (guard PlatformFeeOverCap=${PLATFORM_FEE_OVER_CAP}), landed`, SUB, st.guard, 'register_escrow', [addr(F1)], PLATFORM_FEE_OVER_CAP, [
    { contractId: st.guard, fn: 'registration', args: [addr(F1)] },
    { contractId: F1, fn: 'get_escrow', args: [] },
  ]);
  const f1Summary = summarize(f1, PLATFORM_FEE_OVER_CAP);
  chain.note('F1 registration after the refusal (null: never registered)', await registration(F1));
  const F2 = await newEscrow(`F2 (platform_fee ${probe.at} bps, at the cap)`, AMT, { platformFeeBps: probe.at });
  await must('F2: buyer sends 1 unit of dust (register_escrow needs a balance above zero)', BUYER, st.sac, 'transfer', [addr(B), addr(F2), i128(1n)]);
  const f2 = await register('F2 at the cap', F2);
  chain.note('F2 registration', await registration(F2));

  // W: seller paid alone through withdraw_remaining_funds past a buyer with no trustline.
  const X = Keypair.random(); // throwaway buyer; the secret never leaves this process
  const xb = X.publicKey();
  chain.note('W throwaway buyer (public key)', xb);
  await fundWithFriendbot(chain.server, chain.cfg, xb);
  const tl = await chain.classic('W: throwaway buyer adds the asset trustline', X, [Operation.changeTrust({ asset })]);
  if (tl.status !== 'SUCCESS') throw new Error(`W trustline: ${tl.status}`);
  await chain.classic(`W: buyer role sends the throwaway buyer ${toAmountString(AMT)} ${unit}`, BUYER, [Operation.payment({ destination: xb, asset, amount: toAmountString(AMT) })]);
  const W = await newEscrow('W', AMT, { buyer: xb });
  await fund('W (throwaway buyer)', W, AMT, X);
  await register('W (funded_at)', W);
  const rm = await chain.classic('W: throwaway buyer removes its trustline (it can no longer receive the asset)', X, [Operation.changeTrust({ asset, limit: '0' })]);
  if (rm.status !== 'SUCCESS') throw new Error(`W trustline removal: ${rm.status}`);
  await must('W: 1 unit of dust sent to the escrow (any third party can)', BUYER, st.sac, 'transfer', [addr(B), addr(W), i128(1n)]);
  await must('W: platform dispute_escrow', PLATFORM, W, 'dispute_escrow', [addr(PLATFORM.publicKey())]);
  await register('W (records dispute)', W);
  const sellerOnly = distributions([[S, AMT]]);
  await guarded('W seller withdrawal without a claim (guard NoClaim=8)', W, 'withdraw_remaining_funds', [g, fee, sellerOnly], K.resolver, { kind: 'Resolve' }, false);
  const claim = await anchorClaim('W', W);
  const readyAt = Date.now() / 1000 + st.guardConfig.delay;
  const wait = secondsToWait([readyAt], Date.now() / 1000);
  chain.note(`waiting ${wait} s (testnet delay ${st.guardConfig.delay} s; production 7 days)`);
  await sleep(wait);
  const branch = { kind: 'ResolveSeller' as const, claim };
  await guarded('W resolve_dispute with the buyer leg the dust forces (the token refuses: no trustline)', W, 'resolve_dispute', [g, fee, distributions([[S, AMT], [xb, 1n]])], K.resolver, branch, false);
  await guarded('W resolve_dispute paying the seller the whole balance (guard SellerOverAmount=28)', W, 'resolve_dispute', [g, fee, distributions([[S, AMT + 1n]])], K.resolver, branch, false);
  const s0 = await bal(S);
  let wr = await guarded('W withdraw_remaining_funds: seller paid alone against the claim', W, 'withdraw_remaining_funds', [g, fee, sellerOnly], K.resolver, branch, true);
  for (let i = 0; i < EARLY_RETRIES && refusedWith(wr, 10); i++) {
    await sleep(10);
    wr = await guarded('W withdraw_remaining_funds: seller paid alone against the claim (retry)', W, 'withdraw_remaining_funds', [g, fee, sellerOnly], K.resolver, branch, true);
  }
  const wLanded = ok(wr);
  chain.note('W seller received', ((await bal(S)) - s0).toString());
  chain.note('W escrow balance left for the buyer', (await bal(W)).toString());
  const regW = await registration(W);
  chain.note('W registration', regW);
  const second = await guarded('W second seller withdrawal (guard Closed=17)', W, 'withdraw_remaining_funds', [g, fee, distributions([[S, 1n]])], K.resolver, branch, false);
  const check = await recheckClaim(claim, new RpcRegistry(chain, st.registry, src), new RpcGuard(chain, st.guard, src));
  chain.note('W public re-check of the claim', check);

  writeState({ ...st, claims: [...(st.claims ?? []), claimToFile(claim, 'testnet', st.registry)] });
  const summary = {
    feeCapRefusalLanded: f1Summary.confirmed,
    atCapRegistered: ok(f2),
    sellerWithdrawalLanded: wLanded,
    registrationClosed: regW?.closed === true,
    secondWithdrawalRefused: isRefusal(second) && refusedWith(second, 17),
    claimRecheckOk: check.ok,
  };
  chain.note('landed refusals', [f1Summary]);
  chain.note('summary', summary);
  const logPath = k.exportLog('v010');
  const allOk = Object.values(summary).every(Boolean);
  out.log(`   ${f1Summary.confirmed ? 'FAILED on chain as expected' : f1Summary.status} #${f1Summary.expectedCode} ${f1Summary.label} ${f1Summary.link ?? f1Summary.reason ?? ''} ${f1Summary.errors?.join('; ') ?? ''}`);
  out.log(`#### ${allOk ? 'done' : 'INCOMPLETE'}; run log ${logPath}`);
  return allOk ? 0 : 2;
}

if (isMain(import.meta.url)) runMain(() => main());
