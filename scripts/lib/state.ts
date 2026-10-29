/**
 * testnet-state.json: public IDs written by deploy.ts and read by e2e.ts and the
 * re-check script. It holds no secrets and is git-ignored because every
 * `testnet:keys` run starts a fresh world.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { TESTNET_STATE_FILE } from './paths.js';
import type { ClaimFile } from './claims.js';

export interface GuardConfigRecord {
  delay: number;
  rotateDelay: number;
  contestWindow: number;
  platformFeeBps: number;
}

export interface TestnetState {
  network: 'testnet';
  deployedAt: string;
  /** Stand-in asset code and issuer (testnet substitute for EURC). */
  asset: { code: string; issuer: string };
  /** Contract IDs (C...). */
  sac: string;
  registry: string;
  guard: string;
  /** A fresh instance of Trustless Work's testnet Wasm, used as the escrow deployer. */
  twDeployer: string;
  guardWasmHash: string;
  registryWasmHash: string;
  twWasmHash: string;
  guardConfig: GuardConfigRecord;
  /** Claims anchored by e2e runs, for `npm run claims:recheck`. */
  claims?: ClaimFile[];
}

export function readState(path = TESTNET_STATE_FILE): TestnetState {
  if (!existsSync(path)) throw new Error(`no ${path}; run \`npm run testnet:deploy\` first`);
  return JSON.parse(readFileSync(path, 'utf8')) as TestnetState;
}

export function writeState(s: TestnetState, path = TESTNET_STATE_FILE): void {
  writeFileSync(path, JSON.stringify(s, null, 2) + '\n');
}
