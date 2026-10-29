/**
 * npm run testnet:e2e [-- --silent-buyer] [-- --amount 2]
 *
 * `--amount` is the per-order amount (default: testnet-state.json's orderAmount, else 100).
 * The buyer must hold about twice that (three times with --silent-buyer); see BUYER_BUDGET.
 *
 * TESTNET ONLY (refuses any other network, statically and by asking the RPC).
 * Runs real orders against Trustless Work's testnet Wasm with the guard holding
 * release_signer and dispute_resolver, using the IDs in testnet-state.json:
 *
 *   A. release:   create escrow -> guard precheck -> buyer funds -> register ->
 *                 buyer approves -> anchor the delivery claim -> release through
 *                 the guard's Release key; the claim is then re-checked on-chain.
 *   B. refund:    buyer funds -> buyer disputes -> resolver refunds the buyer ->
 *                 the platform tops up the two fees so the buyer gets 100%.
 *   C. break-glass: 40% funding -> platform dispute -> break-glass key refunds
 *                 the whole balance to the buyer -> top-up.
 *   D. (--silent-buyer) seller paid against an anchored depth-32 claim after the
 *      delay (the same scenario as `npm run testnet:e2e-claims`, which also runs
 *      the buyer-contest flow).
 *
 * Refused paths (the guard's own error codes) are shown by enforce-mode
 * simulation and never submitted. Prints stellar.expert links and exports the
 * run log (public tx hashes only) to scripts/out/.
 *
 * Ported from architect/testnet/arch.mjs (E1-E3 flows) and
 * architect/testnet-v08/arch8.mjs; the refund top-up follows flows-money/tn4.sh.
 * The carrier's delivered event comes from a DeliveryOracle port; this script
 * uses a mock oracle, so no carrier data is involved. The shared steps live in
 * testnet/order-kit.ts.
 */
import { parseArgs } from 'node:util';
import { claimToFile } from '../lib/claims.js';
import { consoleOut, isMain, runMain, type Out } from '../lib/cli.js';
import { FileKeyStore, type KeyStore } from '../lib/keystore.js';
import { addr, distributions, u32 } from '../lib/scval.js';
import { writeState } from '../lib/state.js';
import { recheckClaim } from '../claims/recheck-core.js';
import { RpcGuard, RpcRegistry } from '../claims/rpc-readers.js';
import { openOrderKit, sleep } from './order-kit.js';
import { secondsToWait, silentBuyerPayout, silentBuyerSetup } from './e2e-claims.js';

export { MockDeliveryOracle, toAmountString, type DeliveredEvent, type DeliveryOracle } from './order-kit.js';

export async function main(argv: string[] = process.argv.slice(2), store: KeyStore = new FileKeyStore(), out: Out = consoleOut): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { 'silent-buyer': { type: 'boolean', default: false }, amount: { type: 'string' } } });
  const k = await openOrderKit(store, out, { amount: values.amount, script: values['silent-buyer'] ? 'e2e --silent-buyer' : 'e2e' });
  const { chain, st, src, amt: AMT, keys: K, BUYER, PLATFORM, B, S, fee, wrongFee, g, bal, newEscrow, fund, register, guarded, anchorClaim, topUp } = k;

  out.log(`\n#### e2e ${new Date().toISOString()} guard=${st.guard} registry=${st.registry} sac=${st.sac} tw=${st.twDeployer}`);

  const claims = st.claims ?? [];

  // A: release path with a delivery claim.
  const A = await newEscrow('A', AMT);
  await fund('A', A, AMT);
  await register('A', A);
  await guarded('A release before buyer approval (Trustless Work refuses)', A, 'release_funds', [g, fee], K.release, { kind: 'Release' }, false);
  await chain.invoke('A: buyer approve_milestone', BUYER, A, 'approve_milestone', [u32(0), addr(B)]);
  await register('A (records approval)', A);
  const claimA = await anchorClaim('A', A);
  await guarded('A release with a wrong trustless_work_address (guard BadFeeAddr=15)', A, 'release_funds', [g, wrongFee], K.release, { kind: 'Release' }, false);
  await guarded('A release signed with the resolver key (traps)', A, 'release_funds', [g, fee], K.resolver, { kind: 'Release' }, false);
  const s0 = await bal(S);
  await guarded('A release_funds through the guard', A, 'release_funds', [g, fee], K.release, { kind: 'Release' }, true);
  chain.note('A seller received', ((await bal(S)) - s0).toString());
  const fileA = claimToFile(claimA, 'testnet', st.registry);
  claims.push(fileA);
  const check = await recheckClaim(claimA, new RpcRegistry(chain, st.registry, src), new RpcGuard(chain, st.guard, src));
  chain.note('A public re-check of the claim', check);

  // B: buyer dispute -> resolver refund to the buyer -> platform top-up.
  const Bx = await newEscrow('B', AMT);
  const bBefore = await bal(B);
  await fund('B', Bx, AMT);
  await register('B', Bx);
  await chain.invoke('B: buyer dispute_escrow', BUYER, Bx, 'dispute_escrow', [addr(B)]);
  await register('B (records dispute)', Bx);
  await guarded('B resolve to the seller without a claim (guard NoClaim=8)', Bx, 'resolve_dispute', [g, fee, distributions([[S, AMT]])], K.resolver, { kind: 'Resolve' }, false);
  const balB = await bal(Bx);
  await guarded('B resolve_dispute: whole balance to the buyer', Bx, 'resolve_dispute', [g, fee, distributions([[B, balB]])], K.resolver, { kind: 'Resolve' }, true);
  await topUp('B', AMT, bBefore - AMT);

  // C: partial funding, platform dispute, break-glass refund.
  const C = await newEscrow('C', AMT);
  const part = (AMT * 4n) / 10n;
  const cBefore = await bal(B);
  await fund('C (40%)', C, part);
  await register('C at 40% funding', C);
  await chain.invoke('C: platform dispute_escrow', PLATFORM, C, 'dispute_escrow', [addr(PLATFORM.publicKey())]);
  await guarded('C break-glass to the seller (guard NotWholeToBuyer=13)', C, 'resolve_dispute', [g, fee, distributions([[S, part]])], K.breakglass, { kind: 'BreakGlass' }, false);
  await guarded('C break-glass: whole balance to the buyer', C, 'resolve_dispute', [g, fee, distributions([[B, part]])], K.breakglass, { kind: 'BreakGlass' }, true);
  await topUp('C', part, cBefore - part);

  // D (optional): silent buyer, seller paid against an anchored depth-32 claim after the delay.
  let dOk = true;
  if (values['silent-buyer']) {
    const d = await silentBuyerSetup(k);
    const wait = secondsToWait([d.readyAt], Date.now() / 1000);
    chain.note(`waiting ${wait} s (testnet delay ${st.guardConfig.delay} s; production 7 days)`);
    await sleep(wait);
    const dr = await silentBuyerPayout(k, d);
    dOk = dr.landed && dr.check.ok;
    claims.push(claimToFile(d.claim, 'testnet', st.registry));
  }

  writeState({ ...st, claims });
  const logPath = k.exportLog('e2e');
  out.log(`#### done; run log ${logPath}; re-check with: npm run claims:recheck -- --from-state`);
  return check.ok && dOk ? 0 : 2;
}

if (isMain(import.meta.url)) runMain(() => main());
