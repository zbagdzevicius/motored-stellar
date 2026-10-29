/**
 * npm run testnet:refusals [-- --amount 2]
 *
 * TESTNET ONLY (refuses any other network, statically and by asking the RPC).
 * Lands the guard's refusals on the ledger as FAILED transactions, so each one
 * can be read on stellar.expert with the guard's error code, instead of only
 * being shown by a local enforce-mode simulation. Uses the deployment in
 * testnet-state.json. Four orders, each refused once and then settled the
 * legitimate way on the same escrow:
 *
 *   A. release with a wrong trustless_work_address  -> guard BadFeeAddr (#15);
 *      then the release with the pinned fee address pays the seller.
 *   B. buyer dispute, resolver pays the seller without a claim -> guard NoClaim (#8);
 *      then the whole balance is refunded to the buyer (plus fee top-up).
 *   C. 40% funding, platform dispute, break-glass key pays the seller
 *      -> guard NotWholeToBuyer (#13); then break-glass refunds the buyer (plus top-up).
 *   E. buyer approves, seller disputes, buyer contests on the guard; the claimless
 *      seller payout inside the contest window -> guard Contested (#25); then the
 *      whole balance is refunded to the buyer (plus top-up).
 *
 * How a refusal lands (Chain.landRefusal): the enforce-mode simulation must fail
 * with the expected code first; a call the guard would accept is never
 * submitted. The footprint is the union of the refused call's record-mode
 * footprint and the accepted alternative's enforce-mode footprint on the same
 * escrow, with the accepted path's resources plus headroom. The ledger's own
 * diagnostic events are then read back to confirm the error code.
 *
 * Exports the run log (public tx hashes only) to scripts/out/refusals-*.json.
 */
import { parseArgs } from 'node:util';
import { consoleOut, isMain, runMain, type Out } from '../lib/cli.js';
import { FileKeyStore, type KeyStore } from '../lib/keystore.js';
import { addr, distributions, u32 } from '../lib/scval.js';
import { isRefusal, isTx, type LandedRefusal, type Refusal } from '../lib/soroban.js';
import { openOrderKit } from './order-kit.js';
import { contestSetup } from './e2e-claims.js';

export interface RefusalSummary {
  label: string;
  expectedCode: number;
  status: string;
  link?: string;
  errors?: string[];
  confirmed: boolean;
  reason?: string;
}

export function summarize(r: LandedRefusal | Refusal, expectedCode: number): RefusalSummary {
  if (isRefusal(r)) return { label: r.label, expectedCode, status: 'NOT LANDED', confirmed: false, reason: r.refused };
  return { label: r.label, expectedCode, status: r.status, link: r.link, errors: r.errors ?? [], confirmed: r.confirmed };
}

export async function main(argv: string[] = process.argv.slice(2), store: KeyStore = new FileKeyStore(), out: Out = consoleOut): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { amount: { type: 'string' } } });
  const k = await openOrderKit(store, out, { amount: values.amount, script: 'refusals' });
  const { chain, st, amt: AMT, SUB, keys: K, BUYER, PLATFORM, B, S, fee, wrongFee, g, bal, newEscrow, fund, register, guarded, topUp, must } = k;
  out.log(`\n#### refusals ${new Date().toISOString()} guard=${st.guard} registry=${st.registry} sac=${st.sac} tw=${st.twDeployer}`);
  const results: RefusalSummary[] = [];
  const settled: Record<string, boolean> = {};
  const ok = (r: unknown) => isTx(r) && r.status === 'SUCCESS';

  // A: wrong fee address on release.
  const A = await newEscrow('A', AMT);
  await fund('A', A, AMT);
  await register('A', A);
  await must('A: buyer approve_milestone', BUYER, A, 'approve_milestone', [u32(0), addr(B)]);
  await register('A (records approval)', A);
  results.push(summarize(await chain.landRefusal('A release with a wrong trustless_work_address (guard BadFeeAddr=15), landed', SUB, A, 'release_funds', [g, wrongFee], K.release, { kind: 'Release' }, 15,
    { args: [g, fee], key: K.release, branch: { kind: 'Release' } }), 15));
  settled.A = ok(await guarded('A release_funds through the guard (pinned fee address)', A, 'release_funds', [g, fee], K.release, { kind: 'Release' }, true));

  // B: resolver pays the seller without a claim.
  const Bx = await newEscrow('B', AMT);
  const bBefore = await bal(B);
  await fund('B', Bx, AMT);
  await register('B', Bx);
  await must('B: buyer dispute_escrow', BUYER, Bx, 'dispute_escrow', [addr(B)]);
  await register('B (records dispute)', Bx);
  const balB = await bal(Bx);
  results.push(summarize(await chain.landRefusal('B resolve to the seller without a claim (guard NoClaim=8), landed', SUB, Bx, 'resolve_dispute', [g, fee, distributions([[S, AMT]])], K.resolver, { kind: 'Resolve' }, 8,
    { args: [g, fee, distributions([[B, balB]])], key: K.resolver, branch: { kind: 'Resolve' } }), 8));
  const rb = await guarded('B resolve_dispute: whole balance to the buyer', Bx, 'resolve_dispute', [g, fee, distributions([[B, balB]])], K.resolver, { kind: 'Resolve' }, true);
  settled.B = ok(rb);
  if (settled.B) await topUp('B', AMT, bBefore - AMT);

  // C: break-glass key tries to pay the seller.
  const C = await newEscrow('C', AMT);
  const part = (AMT * 4n) / 10n;
  const cBefore = await bal(B);
  await fund('C (40%)', C, part);
  await register('C at 40% funding', C);
  await must('C: platform dispute_escrow', PLATFORM, C, 'dispute_escrow', [addr(PLATFORM.publicKey())]);
  results.push(summarize(await chain.landRefusal('C break-glass to the seller (guard NotWholeToBuyer=13), landed', SUB, C, 'resolve_dispute', [g, fee, distributions([[S, part]])], K.breakglass, { kind: 'BreakGlass' }, 13,
    { args: [g, fee, distributions([[B, part]])], key: K.breakglass, branch: { kind: 'BreakGlass' } }), 13));
  const rc = await guarded('C break-glass: whole balance to the buyer', C, 'resolve_dispute', [g, fee, distributions([[B, part]])], K.breakglass, { kind: 'BreakGlass' }, true);
  settled.C = ok(rc);
  if (settled.C) await topUp('C', part, cBefore - part);

  // E: seller payout while the buyer's contest stands.
  const e = await contestSetup(k);
  const balE = await bal(e.escrow);
  results.push(summarize(await chain.landRefusal('E seller payout during the buyer contest (guard Contested=25), landed', SUB, e.escrow, 'resolve_dispute', [g, fee, distributions([[S, AMT]])], K.resolver, { kind: 'Resolve' }, 25,
    { args: [g, fee, distributions([[B, balE]])], key: K.resolver, branch: { kind: 'Resolve' } }), 25));
  const re = await guarded('E resolve_dispute: whole balance to the buyer', e.escrow, 'resolve_dispute', [g, fee, distributions([[B, balE]])], K.resolver, { kind: 'Resolve' }, true);
  settled.E = ok(re);
  if (settled.E) await topUp('E', AMT, e.buyerBefore);

  chain.note('landed refusals', results);
  chain.note('settled after the refusal', settled);
  const logPath = k.exportLog('refusals');
  const allOk = results.every((r) => r.confirmed) && Object.values(settled).every(Boolean);
  for (const r of results) out.log(`   ${r.confirmed ? 'FAILED on chain as expected' : r.status} #${r.expectedCode} ${r.label} ${r.link ?? r.reason ?? ''} ${r.errors?.join('; ') ?? ''}`);
  out.log(`#### ${allOk ? 'done' : 'INCOMPLETE'}; run log ${logPath}`);
  return allOk ? 0 : 2;
}

if (isMain(import.meta.url)) runMain(() => main());
