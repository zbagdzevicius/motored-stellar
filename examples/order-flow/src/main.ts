// SPDX-License-Identifier: Apache-2.0
//
// npm run example                 one order per scenario, every port in memory
// npm run example -- --testnet    the same flows against Stellar testnet
//
// In-memory mode needs no network, no keys on disk and no secrets: every key is
// created at runtime with Keypair.random() and discarded at exit.
//
// --testnet hands over to scripts/testnet/e2e.ts, which runs the same order flow
// (create, precheck, fund, register, approve, anchor, guarded release; refund
// with top-up; break-glass; and, with --silent-buyer, the claim-backed seller
// payout) against Trustless Work's testnet Wasm with the guard and registry that
// `npm run testnet:deploy` deployed. Its keys come from `npm run testnet:keys`
// (Keypair.random + friendbot, stored only in the git-ignored .keys/ folder).

import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { formatUnits } from '@motored-stellar/escrow';
import { runScenario1, runScenario2, type ScenarioResult } from './scenarios.js';

const log = (line: string): void => console.log(line);

function summary(name: string, r: ScenarioResult): boolean {
  let ok = r.reconciliation.pass;
  for (const o of r.orders) {
    const sellerOk = o.sellerReceived === 0n || o.sellerReceived >= o.cardNet;
    const refundOk = o.buyerRefunded === 0n || o.buyerRefunded === o.amount;
    ok &&= sellerOk && refundOk;
    log(
      `  ${name} ${o.contractId.slice(0, 10)}...: seller ${formatUnits(o.sellerReceived)} (card net ${formatUnits(o.cardNet)}), ` +
        `buyer refunded ${formatUnits(o.buyerRefunded)} of ${formatUnits(o.amount)}, platform net ${formatUnits(o.platformNet)}, ` +
        `Trustless Work ${formatUnits(o.trustlessWorkFee)}` +
        (o.claimVerified === undefined ? '' : `, claim verifies: ${o.claimVerified}`),
    );
  }
  log(`  ${name}: ${r.transactions} transactions, reconciliation ${r.reconciliation.pass ? 'PASS' : 'FAIL'}`);
  return ok;
}

async function runInMemory(): Promise<number> {
  log('motored-stellar example order flow (in-memory ports, no network)\n');
  const s1 = await runScenario1(log);
  log('');
  const s2 = await runScenario2(log);
  log('\nSummary');
  const ok1 = summary('scenario 1', s1);
  const ok2 = summary('scenario 2', s2);
  const ok = ok1 && ok2;
  log(ok ? '\nAll checks passed.' : '\nA check FAILED.');
  return ok ? 0 : 1;
}

async function runTestnet(rest: string[]): Promise<number> {
  // Resolved at runtime so the example has no compile-time dependency on the scripts workspace.
  const e2e = new URL('../../../scripts/testnet/e2e.ts', import.meta.url);
  const mod = (await import(e2e.href)) as { main: (argv: string[]) => Promise<number> };
  log('motored-stellar example order flow on Stellar TESTNET (delegating to scripts/testnet/e2e.ts)\n');
  return mod.main(rest);
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { testnet: { type: 'boolean', default: false }, 'silent-buyer': { type: 'boolean', default: false } },
    allowPositionals: true,
  });
  if (values.testnet) return runTestnet([...(values['silent-buyer'] ? ['--silent-buyer'] : []), ...positionals]);
  return runInMemory();
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
