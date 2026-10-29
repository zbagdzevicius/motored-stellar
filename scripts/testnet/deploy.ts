/**
 * npm run testnet:deploy [-- --delay 120 --contest-window 120 --rotate-delay 604800]
 *                        [-- --guard-wasm <path> --registry-wasm <path>]
 *
 * TESTNET ONLY. Stands up a fresh world from the keys in `.keys/testnet.json`:
 *   1. a stand-in asset XEUR issued by the `issuer` role (testnet substitute for EURC),
 *      trustlines for buyer, seller, platform, twFee and third, and the asset's SAC;
 *   2. the claim registry (issuer = sponsor, revoker = revoker);
 *   3. the guard, uploaded through a fee-bump (a plain upload exceeds the u32 fee
 *      field on testnet), with its Cfg pinned to Trustless Work's testnet Wasm;
 *   4. a fresh instance of Trustless Work's testnet Wasm, used as the atomic
 *      deploy+init entry point for escrows.
 * Writes the public IDs to testnet-state.json (git-ignored).
 *
 * Build first (from the repo root):
 *   contracts/third_party/tw-wasm/fetch.sh            # not needed here, needed by cargo test
 *   stellar contract build                            # or: cargo build --target wasm32v1-none --release
 *   stellar contract optimize --wasm contracts/target/wasm32v1-none/release/motored_escrow_guard.wasm \
 *     --wasm-out contracts/target/wasm32v1-none/release/motored_escrow_guard.optimized.wasm   # optional, cheaper upload
 *
 * Ported from architect/testnet-v08/setup.sh and upload.mjs. The lab's guard
 * keys came from fixed public seeds; these come from the KeyStore.
 * Lab timings (delay = contest window = 120 s) are the defaults so the e2e run
 * finishes in minutes; production uses 7 days.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Asset, Operation, type xdr } from '@stellar/stellar-sdk';
import { isMain, runMain, consoleOut, type Out } from '../lib/cli.js';
import { FileKeyStore, accountKeypair, requireKeys, type KeyStore, type TestnetKeys } from '../lib/keystore.js';
import { assertTestnetLive, contractLink, testnetConfig } from '../lib/network.js';
import { WASM_DIR } from '../lib/paths.js';
import { addr, bytes, map, optAddr, u64 } from '../lib/scval.js';
import { Chain } from '../lib/soroban.js';
import { writeState, type TestnetState } from '../lib/state.js';
import { TW_WASM_HASH } from '../lib/tw.js';

export const ASSET_CODE = 'XEUR';
/** Buyer float: 5,000 XEUR (stand-in units, 7 decimals). */
const BUYER_FLOAT = '5000';
/** Platform float so refund top-ups never wait on fee income. */
const PLATFORM_FLOAT = '100';

export interface GuardCfgInput {
  keys: TestnetKeys;
  registry: string;
  token: string;
  delay: number;
  rotateDelay: number;
  contestWindow: number;
}

/** The guard's `Cfg` constructor argument (contracts/guard), fields sorted by name. */
export function guardCfg(i: GuardCfgInput): xdr.ScVal {
  const k = i.keys;
  return map({
    admin: addr(k.accounts.admin.publicKey),
    breakglass_pk: bytes(Buffer.from(k.guardKeys.breakglass.publicKeyHex, 'hex')),
    contest_window: u64(i.contestWindow),
    delay: u64(i.delay),
    platform: addr(k.accounts.platform.publicKey),
    registry: addr(i.registry),
    release_pk: bytes(Buffer.from(k.guardKeys.release.publicKeyHex, 'hex')),
    resolver_admin: addr(k.accounts.admin.publicKey),
    resolver_pk: bytes(Buffer.from(k.guardKeys.resolver.publicKeyHex, 'hex')),
    rotate_delay: u64(i.rotateDelay),
    token: addr(i.token),
    // Testnet Wasm 7c3f7b2a takes trustless_work_address as an argument, so the guard pins it.
    tw_fee: optAddr(k.accounts.twFee.publicKey),
    tw_wasm: bytes(Buffer.from(TW_WASM_HASH.testnet, 'hex')),
  });
}

function pickWasm(explicit: string | undefined, base: string): string {
  if (explicit) return resolve(explicit);
  const optimized = resolve(WASM_DIR, `${base}.optimized.wasm`);
  if (existsSync(optimized)) return optimized;
  const plain = resolve(WASM_DIR, `${base}.wasm`);
  if (!existsSync(plain)) throw new Error(`missing ${plain}; build the contracts first (see the header of this file)`);
  return plain;
}

export async function main(argv: string[] = process.argv.slice(2), store: KeyStore = new FileKeyStore(), out: Out = consoleOut): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      delay: { type: 'string', default: '120' },
      'contest-window': { type: 'string', default: '120' },
      'rotate-delay': { type: 'string', default: '604800' },
      'platform-fee-bps': { type: 'string', default: '470' },
      'guard-wasm': { type: 'string' },
      'registry-wasm': { type: 'string' },
    },
  });
  const cfg = testnetConfig(process.env.MS_TESTNET_RPC);
  const chain = new Chain(cfg, out.log);
  await assertTestnetLive(chain.server, cfg);
  const keys = requireKeys(store);
  const kp = (r: Parameters<typeof accountKeypair>[1]) => accountKeypair(keys, r);
  const sponsor = kp('sponsor');
  const issuer = kp('issuer');

  // 1. Stand-in asset, trustlines, floats, SAC.
  const asset = new Asset(ASSET_CODE, issuer.publicKey());
  for (const role of ['buyer', 'seller', 'platform', 'twFee', 'third'] as const) {
    await chain.classic(`trustline ${role}`, kp(role), [Operation.changeTrust({ asset })]);
  }
  await chain.classic('issue floats', issuer, [
    Operation.payment({ destination: keys.accounts.buyer.publicKey, asset, amount: BUYER_FLOAT }),
    Operation.payment({ destination: keys.accounts.platform.publicKey, asset, amount: PLATFORM_FLOAT }),
    Operation.payment({ destination: keys.accounts.third.publicKey, asset, amount: '0.0001' }),
  ]);
  const sac = await chain.deploySac('deploy XEUR SAC', asset, sponsor);

  // 2. Claim registry.
  const registryWasm = readFileSync(pickWasm(values['registry-wasm'], 'claim_registry'));
  const registryHash = await chain.uploadWasmFeeBump('upload claim registry', registryWasm, sponsor);
  const registry = await chain.deployContract('deploy claim registry', sponsor, registryHash, [
    addr(keys.accounts.sponsor.publicKey),
    addr(keys.accounts.revoker.publicKey),
  ]);

  // 3. Guard.
  const delay = Number(values.delay);
  const contestWindow = Number(values['contest-window']);
  const rotateDelay = Number(values['rotate-delay']);
  const guardWasm = readFileSync(pickWasm(values['guard-wasm'], 'motored_escrow_guard'));
  const guardHash = await chain.uploadWasmFeeBump('upload guard', guardWasm, sponsor);
  const guard = await chain.deployContract('deploy guard', sponsor, guardHash, [
    guardCfg({ keys, registry, token: sac, delay, rotateDelay, contestWindow }),
  ]);

  // 4. Trustless Work deployer instance (their Wasm is already on testnet; nothing is uploaded).
  const twDeployer = await chain.deployContract('deploy Trustless Work testnet Wasm instance', sponsor, TW_WASM_HASH.testnet);

  const state: TestnetState = {
    network: 'testnet',
    deployedAt: new Date().toISOString(),
    asset: { code: ASSET_CODE, issuer: issuer.publicKey() },
    sac,
    registry,
    guard,
    twDeployer,
    guardWasmHash: guardHash,
    registryWasmHash: registryHash,
    twWasmHash: TW_WASM_HASH.testnet,
    guardConfig: { delay, rotateDelay, contestWindow, platformFeeBps: Number(values['platform-fee-bps']) },
    claims: [],
  };
  writeState(state);
  for (const [n, id] of Object.entries({ sac, registry, guard, twDeployer })) out.log(`${n.padEnd(10)} ${id} ${contractLink(cfg, id)}`);
  out.log('wrote testnet-state.json');
  return 0;
}

if (isMain(import.meta.url)) runMain(() => main());
