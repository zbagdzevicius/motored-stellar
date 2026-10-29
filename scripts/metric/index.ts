/**
 * npm run metric -- --footprint <footprint.json> [--observations <file>] [--rpc <url>]
 *                   [--start-ledger n] [--save-observations <file>] [--per-escrow] [--json]
 *
 * Recomputes the Tranche 3 on-chain metric from the registered footprint and
 * prints the verdict (exit 0 PASS, 3 FAIL). Read-only: it never signs or
 * submits, so mainnet is allowed here, through an explicit --rpc.
 *
 * Data comes from either a recorded observation file (an indexer export, or a
 * file saved by an earlier run with --save-observations) or live RPC reads.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { consoleOut, isMain, runMain, type Out } from '../lib/cli.js';
import { mainnetReadOnly, testnetConfig, type NetworkConfig } from '../lib/network.js';
import { Chain } from '../lib/soroban.js';
import { collectObservations, RpcEscrowStateReader, RpcEventSource } from './collect.js';
import { computeFootprintMetric, observationsFromFile, observationsToFile, renderReport, type EscrowObservation, type Footprint, type ObservationFile } from './metric.js';

export async function main(argv: string[] = process.argv.slice(2), out: Out = consoleOut): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      footprint: { type: 'string' },
      observations: { type: 'string' },
      rpc: { type: 'string' },
      'start-ledger': { type: 'string' },
      'save-observations': { type: 'string' },
      'per-escrow': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
    },
  });
  if (!values.footprint) throw new Error('--footprint <file> is required');
  const fp = JSON.parse(readFileSync(values.footprint, 'utf8')) as Footprint;
  if (fp.network !== 'testnet' && fp.network !== 'mainnet') throw new Error('footprint.network must be testnet or mainnet');

  let observations: EscrowObservation[];
  if (values.observations) {
    observations = observationsFromFile(JSON.parse(readFileSync(values.observations, 'utf8')) as ObservationFile);
  } else {
    let cfg: NetworkConfig;
    if (fp.network === 'mainnet') {
      if (!values.rpc) throw new Error('mainnet reads need --rpc <mainnet RPC URL>');
      cfg = mainnetReadOnly(values.rpc);
    } else {
      cfg = testnetConfig(values.rpc ?? process.env.MS_TESTNET_RPC);
    }
    const chain = new Chain(cfg, () => undefined);
    const startLedger = Number(values['start-ledger'] ?? fp.startLedger ?? NaN);
    if (!Number.isInteger(startLedger)) throw new Error('live reads need --start-ledger (or footprint.startLedger)');
    // The platform account exists on every network the footprint names; it is only a simulation source.
    observations = await collectObservations(fp, new RpcEscrowStateReader(chain, fp.platform), new RpcEventSource(chain.server), startLedger);
    if (values['save-observations']) {
      writeFileSync(values['save-observations'], JSON.stringify(observationsToFile(observations, `rpc ${cfg.rpcUrl} from ledger ${startLedger}`), null, 2) + '\n');
    }
  }

  const report = computeFootprintMetric(fp, observations);
  if (values.json) out.log(JSON.stringify(report, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
  else out.log(renderReport(report, { perEscrow: values['per-escrow'] }));
  return report.verdict === 'PASS' ? 0 : 3;
}

if (isMain(import.meta.url)) runMain(() => main());
