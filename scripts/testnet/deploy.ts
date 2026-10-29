/**
 * npm run testnet:deploy [-- --delay 120 --contest-window 120 --rotate-delay 604800]
 *                        [-- --platform-fee-bps 470 --max-platform-fee-bps 500]
 *                        [-- --guard-wasm <path> --registry-wasm <path>]
 *                        [-- --asset EURC:<issuer G...> --amount 2]
 *
 * TESTNET ONLY. Stands up a fresh world from the keys in `.keys/testnet.json`:
 *   1. a stand-in asset XEUR issued by the `issuer` role (testnet substitute for EURC),
 *      trustlines for buyer, seller, platform, twFee and third, and the asset's SAC;
 *      or, with `--asset CODE:ISSUER`, an existing classic asset (Circle's testnet
 *      EURC, see TESTNET_EURC): nothing is issued and no floats are paid, the same
 *      five trustlines are added and the asset's SAC is resolved (deployed only if
 *      missing). The accounts are then funded from Circle's faucet, see
 *      "Real testnet EURC" in scripts/README.md. `--amount` is the per-order amount the e2e scripts
 *      default to (100 for XEUR, 2 for an external asset);
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
import { Asset, Operation, StrKey, type xdr } from '@stellar/stellar-sdk';
import { isMain, runMain, consoleOut, type Out } from '../lib/cli.js';
import { FileKeyStore, accountKeypair, requireKeys, type KeyStore, type TestnetKeys } from '../lib/keystore.js';
import { assertTestnetLive, contractLink, testnetConfig } from '../lib/network.js';
import { WASM_DIR } from '../lib/paths.js';
import { addr, bytes, map, optAddr, u32, u64 } from '../lib/scval.js';
import { Chain } from '../lib/soroban.js';
import { writeState, type TestnetState } from '../lib/state.js';
import { TW_WASM_HASH } from '../lib/tw.js';
import { parseAmount } from './order-kit.js';

export const ASSET_CODE = 'XEUR';
/** Buyer float: 5,000 XEUR (stand-in units, 7 decimals). */
const BUYER_FLOAT = '5000';
/** Platform float so refund top-ups never wait on fee income. */
const PLATFORM_FLOAT = '100';
/** The guard's cap on an escrow's Trustless Work `platform_fee` (guard v0.10 `Cfg::max_platform_fee_bps`): 5%. */
export const DEFAULT_MAX_PLATFORM_FEE_BPS = 500;
/** Default per-order amount for the e2e scripts: 100 XEUR, or 2 units of an external asset (one 10 EURC faucet drip covers every scenario). */
export const DEFAULT_ORDER_AMOUNT = { standIn: '100', external: '2' } as const;

/**
 * Circle's EURC on Stellar testnet. Source: https://developers.circle.com/stablecoins/eurc-contract-addresses
 * ("Stellar Testnet: EURC-GB3Q6QDZYTHWT7E5PVS3W7FUT5GVAFC5KSZFFLPU25GO7VTC3NM2ZTVO"); the issuer's
 * home_domain on Horizon testnet is circle.com. Mainnet EURC has a different issuer and is never used here.
 */
export const TESTNET_EURC = { code: 'EURC', issuer: 'GB3Q6QDZYTHWT7E5PVS3W7FUT5GVAFC5KSZFFLPU25GO7VTC3NM2ZTVO' } as const;
/** Circle's mainnet EURC issuer; refused by --asset so a mainnet asset ID can never slip into a testnet run. */
export const MAINNET_EURC_ISSUER = 'GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2';

/** Parses `--asset CODE:ISSUER` (a classic credit asset). */
export function parseAssetArg(v: string): { code: string; issuer: string } {
  const m = /^([A-Za-z0-9]{1,12}):(G[A-Z2-7]{55})$/.exec(v.trim());
  if (!m) throw new Error(`--asset must be CODE:ISSUER (e.g. ${TESTNET_EURC.code}:${TESTNET_EURC.issuer}), got ${v}`);
  const [, code, issuer] = m as unknown as [string, string, string];
  if (!StrKey.isValidEd25519PublicKey(issuer)) throw new Error(`--asset issuer ${issuer} is not a valid G-address`);
  if (issuer === MAINNET_EURC_ISSUER) throw new Error('--asset names the MAINNET EURC issuer; testnet EURC is ' + TESTNET_EURC.issuer);
  return { code, issuer };
}

export interface GuardCfgInput {
  keys: TestnetKeys;
  registry: string;
  token: string;
  delay: number;
  rotateDelay: number;
  contestWindow: number;
  /** Highest `platform_fee` (bps) the guard registers (v0.10); default DEFAULT_MAX_PLATFORM_FEE_BPS. */
  maxPlatformFeeBps?: number;
}

/** Parses a basis-point flag: an integer from 0 to 10,000 (fits the guard's u32). */
export function parseBps(name: string, v: string): number {
  const n = Number(v);
  if (!/^\d+$/.test(v.trim()) || !Number.isSafeInteger(n) || n > 10_000) throw new Error(`--${name} must be an integer from 0 to 10000 (basis points), got ${v}`);
  return n;
}

/** The guard's `Cfg` constructor argument (contracts/guard), fields sorted by name. */
export function guardCfg(i: GuardCfgInput): xdr.ScVal {
  const k = i.keys;
  return map({
    admin: addr(k.accounts.admin.publicKey),
    breakglass_pk: bytes(Buffer.from(k.guardKeys.breakglass.publicKeyHex, 'hex')),
    contest_window: u64(i.contestWindow),
    delay: u64(i.delay),
    max_platform_fee_bps: u32(i.maxPlatformFeeBps ?? DEFAULT_MAX_PLATFORM_FEE_BPS),
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
      'max-platform-fee-bps': { type: 'string', default: String(DEFAULT_MAX_PLATFORM_FEE_BPS) },
      'guard-wasm': { type: 'string' },
      'registry-wasm': { type: 'string' },
      asset: { type: 'string' },
      amount: { type: 'string' },
    },
  });
  const external = values.asset ? parseAssetArg(values.asset) : undefined;
  const orderAmount = values.amount ?? (external ? DEFAULT_ORDER_AMOUNT.external : DEFAULT_ORDER_AMOUNT.standIn);
  parseAmount(orderAmount); // fail before anything is signed
  const platformFeeBps = parseBps('platform-fee-bps', values['platform-fee-bps']);
  const maxPlatformFeeBps = parseBps('max-platform-fee-bps', values['max-platform-fee-bps']);
  if (platformFeeBps > maxPlatformFeeBps) throw new Error(`--platform-fee-bps ${platformFeeBps} is above the guard's cap --max-platform-fee-bps ${maxPlatformFeeBps}: the guard would refuse every escrow`);
  const cfg = testnetConfig(process.env.MS_TESTNET_RPC);
  const chain = new Chain(cfg, out.log);
  await assertTestnetLive(chain.server, cfg);
  const keys = requireKeys(store);
  const kp = (r: Parameters<typeof accountKeypair>[1]) => accountKeypair(keys, r);
  const sponsor = kp('sponsor');
  const issuer = kp('issuer');

  // 1. Asset, trustlines, floats (stand-in only), SAC.
  const asset = external ? new Asset(external.code, external.issuer) : new Asset(ASSET_CODE, issuer.publicKey());
  if (external) chain.note(`using existing asset ${external.code}:${external.issuer}; nothing is issued, fund the accounts from the faucet`);
  for (const role of ['buyer', 'seller', 'platform', 'twFee', 'third'] as const) {
    const r = await chain.classic(`trustline ${role}`, kp(role), [Operation.changeTrust({ asset })]);
    if (r.status !== 'SUCCESS') throw new Error(`trustline ${role}: ${r.status}`);
  }
  if (!external) {
    await chain.classic('issue floats', issuer, [
      Operation.payment({ destination: keys.accounts.buyer.publicKey, asset, amount: BUYER_FLOAT }),
      Operation.payment({ destination: keys.accounts.platform.publicKey, asset, amount: PLATFORM_FLOAT }),
      Operation.payment({ destination: keys.accounts.third.publicKey, asset, amount: '0.0001' }),
    ]);
  }
  const sac = await chain.deploySac(`deploy ${asset.getCode()} SAC (or resolve the existing one)`, asset, sponsor);

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
    guardCfg({ keys, registry, token: sac, delay, rotateDelay, contestWindow, maxPlatformFeeBps }),
  ]);

  // 4. Trustless Work deployer instance (their Wasm is already on testnet; nothing is uploaded).
  const twDeployer = await chain.deployContract('deploy Trustless Work testnet Wasm instance', sponsor, TW_WASM_HASH.testnet);

  const state: TestnetState = {
    network: 'testnet',
    deployedAt: new Date().toISOString(),
    asset: external ? { ...external, external: true } : { code: ASSET_CODE, issuer: issuer.publicKey() },
    orderAmount,
    sac,
    registry,
    guard,
    twDeployer,
    guardWasmHash: guardHash,
    registryWasmHash: registryHash,
    twWasmHash: TW_WASM_HASH.testnet,
    guardConfig: { delay, rotateDelay, contestWindow, platformFeeBps, maxPlatformFeeBps },
    claims: [],
  };
  writeState(state);
  for (const [n, id] of Object.entries({ sac, registry, guard, twDeployer })) out.log(`${n.padEnd(10)} ${id} ${contractLink(cfg, id)}`);
  out.log('wrote testnet-state.json');
  return 0;
}

if (isMain(import.meta.url)) runMain(() => main());
