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
  /**
   * The escrow asset: the stand-in XEUR issued by the `issuer` role, or an
   * existing classic asset passed with `deploy --asset CODE:ISSUER` (Circle's
   * testnet EURC), in which case `external` is true and nothing was issued.
   */
  asset: { code: string; issuer: string; external?: boolean };
  /** Default order amount for the e2e scripts, as a decimal string (`--amount` overrides it). */
  orderAmount?: string;
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
