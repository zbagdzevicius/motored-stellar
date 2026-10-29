import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Keypair } from '@stellar/stellar-sdk';
import {
  FileKeyStore,
  GUARD_KEY_ROLES,
  InMemoryKeyStore,
  KeyPathError,
  generateTestnetKeys,
  publicView,
} from '../lib/keystore.js';
import { KEYS_DIR, REPO_ROOT, TESTNET_KEYS_FILE } from '../lib/paths.js';
import { main as keysMain } from '../testnet/keys.js';

const SECRET_RE = /S[A-Z2-7]{55}/;

describe('key storage location', () => {
  it('defaults to <repo>/.keys/testnet.json', () => {
    expect(KEYS_DIR).toBe(resolve(REPO_ROOT, '.keys'));
    expect(TESTNET_KEYS_FILE).toBe(resolve(REPO_ROOT, '.keys', 'testnet.json'));
    expect(new FileKeyStore().path).toBe(TESTNET_KEYS_FILE);
  });

  it('refuses any path outside the keys directory', () => {
    for (const p of [resolve(REPO_ROOT, 'testnet.json'), join(tmpdir(), 'testnet.json'), resolve(KEYS_DIR, '..', 'x.json'), KEYS_DIR]) {
      expect(() => new FileKeyStore(p)).toThrow(KeyPathError);
    }
  });

  it('the root .gitignore ignores .keys/', () => {
    const gi = resolve(REPO_ROOT, '.gitignore');
    expect(existsSync(gi), 'root .gitignore must exist').toBe(true);
    const lines = readFileSync(gi, 'utf8').split(/\r?\n/).map((l) => l.trim());
    expect(lines.some((l) => l === '.keys/' || l === '.keys' || l === '/.keys/' || l === '/.keys')).toBe(true);
  });

  it('writes 0600 files and a self-ignoring directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ms-keys-'));
    const store = new FileKeyStore(join(dir, 'testnet.json'), { keysDir: dir });
    const keys = generateTestnetKeys();
    store.save(keys);
    expect(statSync(store.path).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dir, '.gitignore'), 'utf8').trim()).toBe('*');
    expect(store.load()).toEqual(keys);
    expect(() => store.save(keys)).toThrow(/exists/);
  });
});

describe('generated keys', () => {
  it('never reuses the lab fixed guard seeds and are distinct', () => {
    const keys = generateTestnetKeys();
    const fixed = [1, 2, 3].map((b) => Buffer.alloc(32, b).toString('hex'));
    const seeds = GUARD_KEY_ROLES.map((r) => keys.guardKeys[r].seedHex);
    for (const s of seeds) expect(fixed).not.toContain(s);
    expect(new Set(seeds).size).toBe(3);
    const pk = Buffer.from(Keypair.fromRawEd25519Seed(Buffer.from(keys.guardKeys.release.seedHex, 'hex')).rawPublicKey()).toString('hex');
    expect(pk).toBe(keys.guardKeys.release.publicKeyHex);
  });

  it('publicView carries no secret material', () => {
    const keys = generateTestnetKeys();
    const text = JSON.stringify(publicView(keys));
    expect(text).not.toMatch(SECRET_RE);
    for (const r of GUARD_KEY_ROLES) expect(text).not.toContain(keys.guardKeys[r].seedHex);
  });

  it('the keys CLI prints only public keys', async () => {
    const lines: string[] = [];
    const store = new InMemoryKeyStore();
    expect(await keysMain(['--no-fund'], store, { log: (l) => lines.push(l) })).toBe(0);
    const keys = store.load();
    expect(keys).toBeDefined();
    const text = lines.join('\n');
    expect(text).not.toMatch(SECRET_RE);
    for (const r of GUARD_KEY_ROLES) expect(text).not.toContain(keys!.guardKeys[r].seedHex);
    expect(text).toContain(keys!.accounts.buyer.publicKey);
  });
});
