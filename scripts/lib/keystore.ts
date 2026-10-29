/**
 * KeyStore port and its two implementations.
 *
 * Testnet keys are generated at runtime (Keypair.random for accounts, 32 random
 * bytes for each guard ed25519 key) and kept in exactly one place:
 * `<repo>/.keys/testnet.json`, mode 0600, inside a git-ignored directory that
 * also carries its own `*` .gitignore. Nothing here ever prints a secret; use
 * `publicView` for anything that reaches a terminal or a log.
 *
 * The lab derived the guard keys from fixed seeds (32 bytes of 1, 2 and 3).
 * Those seeds are public, so they are not used here.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep, isAbsolute } from 'node:path';
import { Keypair } from '@stellar/stellar-sdk';
import { KEYS_DIR, TESTNET_KEYS_FILE } from './paths.js';

/** Classic accounts the testnet demo needs. */
export const ACCOUNT_ROLES = [
  'sponsor', // pays fees and reserves, deploys contracts, registry issuer (testnet only)
  'issuer', // issues the stand-in XEUR asset (testnet stand-in for EURC)
  'buyer',
  'seller',
  'platform', // platform fee account: the Trustless Work `platform` role, sends refund top-ups
  'twFee', // stand-in for the Trustless Work fee address the testnet Wasm takes as an argument
  'revoker', // registry revoker (offline in production)
  'admin', // guard admin and resolver admin (offline in production)
  'third', // unrelated account used only by negative checks
] as const;
export type AccountRole = (typeof ACCOUNT_ROLES)[number];

/** Raw ed25519 keys the guard verifies inside __check_auth. They hold no funds. */
export const GUARD_KEY_ROLES = ['release', 'resolver', 'breakglass'] as const;
export type GuardKeyRole = (typeof GUARD_KEY_ROLES)[number];

export interface StoredAccount {
  publicKey: string;
  secret: string;
}
export interface StoredGuardKey {
  /** Raw 32-byte ed25519 public key, hex. Goes into the guard Cfg. */
  publicKeyHex: string;
  /** Raw 32-byte ed25519 seed, hex. Never printed. */
  seedHex: string;
}
export interface TestnetKeys {
  version: 1;
  network: 'testnet';
  createdAt: string;
  accounts: Record<AccountRole, StoredAccount>;
  guardKeys: Record<GuardKeyRole, StoredGuardKey>;
}

/** Port: where runtime-generated keys live. */
export interface KeyStore {
  load(): TestnetKeys | undefined;
  save(keys: TestnetKeys, opts?: { overwrite?: boolean }): void;
  /** Human-readable location, for messages. */
  describe(): string;
}

/** Generates a full testnet role set. `rng` is injectable for tests. */
export function generateTestnetKeys(rng: (n: number) => Buffer = randomBytes, now: () => Date = () => new Date()): TestnetKeys {
  const accounts = {} as Record<AccountRole, StoredAccount>;
  for (const role of ACCOUNT_ROLES) {
    const kp = Keypair.fromRawEd25519Seed(rng(32));
    accounts[role] = { publicKey: kp.publicKey(), secret: kp.secret() };
  }
  const guardKeys = {} as Record<GuardKeyRole, StoredGuardKey>;
  for (const role of GUARD_KEY_ROLES) {
    const seed = rng(32);
    const kp = Keypair.fromRawEd25519Seed(seed);
    guardKeys[role] = { publicKeyHex: Buffer.from(kp.rawPublicKey()).toString('hex'), seedHex: seed.toString('hex') };
  }
  return { version: 1, network: 'testnet', createdAt: now().toISOString(), accounts, guardKeys };
}

/** Loads a stored account as a signing keypair. */
export function accountKeypair(keys: TestnetKeys, role: AccountRole): Keypair {
  return Keypair.fromSecret(keys.accounts[role].secret);
}

/** Loads a guard key as a raw ed25519 signer. */
export function guardKeypair(keys: TestnetKeys, role: GuardKeyRole): Keypair {
  return Keypair.fromRawEd25519Seed(Buffer.from(keys.guardKeys[role].seedHex, 'hex'));
}

/** The printable part of a key set: G-addresses and raw guard public keys only. */
export function publicView(keys: TestnetKeys): {
  network: 'testnet';
  accounts: Record<AccountRole, string>;
  guardKeys: Record<GuardKeyRole, string>;
} {
  const accounts = {} as Record<AccountRole, string>;
  for (const r of ACCOUNT_ROLES) accounts[r] = keys.accounts[r].publicKey;
  const guardKeys = {} as Record<GuardKeyRole, string>;
  for (const r of GUARD_KEY_ROLES) guardKeys[r] = keys.guardKeys[r].publicKeyHex;
  return { network: 'testnet', accounts, guardKeys };
}

export class KeyPathError extends Error {
  constructor(path: string, keysDir: string) {
    super(`key files may only be written inside ${keysDir}; got ${path}`);
    this.name = 'KeyPathError';
  }
}

/** True when `path` resolves strictly inside `dir`. */
export function isInside(dir: string, path: string): boolean {
  const rel = relative(resolve(dir), resolve(path));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) && !rel.split(sep).includes('..');
}

/** File-backed store, confined to the git-ignored keys directory. */
export class FileKeyStore implements KeyStore {
  readonly path: string;
  readonly keysDir: string;

  constructor(path: string = TESTNET_KEYS_FILE, opts: { keysDir?: string } = {}) {
    this.keysDir = resolve(opts.keysDir ?? KEYS_DIR);
    this.path = resolve(path);
    if (!isInside(this.keysDir, this.path)) throw new KeyPathError(this.path, this.keysDir);
  }

  describe(): string {
    return this.path;
  }

  load(): TestnetKeys | undefined {
    if (!existsSync(this.path)) return undefined;
    const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as TestnetKeys;
    if (parsed.version !== 1 || parsed.network !== 'testnet') throw new Error(`${this.path}: not a v1 testnet key file`);
    return parsed;
  }

  save(keys: TestnetKeys, opts: { overwrite?: boolean } = {}): void {
    if (keys.network !== 'testnet') throw new Error('only testnet keys are stored');
    if (existsSync(this.path) && !opts.overwrite) throw new Error(`${this.path} exists; pass --force to replace it`);
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    // Belt and braces next to the root .gitignore: the directory ignores itself.
    const localIgnore = resolve(this.keysDir, '.gitignore');
    if (!existsSync(localIgnore)) writeFileSync(localIgnore, '*\n', { mode: 0o600 });
    writeFileSync(this.path, JSON.stringify(keys, null, 2) + '\n', { mode: 0o600 });
    chmodSync(this.path, 0o600);
  }
}

/** In-memory store for tests and the mock example. */
export class InMemoryKeyStore implements KeyStore {
  private keys: TestnetKeys | undefined;
  constructor(initial?: TestnetKeys) {
    this.keys = initial;
  }
  describe(): string {
    return 'memory';
  }
  load(): TestnetKeys | undefined {
    return this.keys;
  }
  save(keys: TestnetKeys, opts: { overwrite?: boolean } = {}): void {
    if (this.keys && !opts.overwrite) throw new Error('keys exist; pass overwrite');
    this.keys = keys;
  }
}

/** Loads keys or explains how to create them. */
export function requireKeys(store: KeyStore): TestnetKeys {
  const keys = store.load();
  if (!keys) throw new Error(`no testnet keys at ${store.describe()}; run \`npm run testnet:keys\` first`);
  return keys;
}
