/**
 * Repository-relative locations used by the CLIs.
 *
 * Every path that can hold key material resolves under `<repo>/.keys/`, which the
 * root .gitignore excludes. Public run state (contract IDs, claims) lives in
 * `<repo>/testnet-state.json`, also git-ignored because it is regenerated per run.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** `<repo>/scripts` */
export const SCRIPTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** `<repo>` */
export const REPO_ROOT = resolve(SCRIPTS_DIR, '..');
/** The only directory key material may ever be written to. */
export const KEYS_DIR = resolve(REPO_ROOT, '.keys');
/** Default testnet key file (0600, git-ignored). */
export const TESTNET_KEYS_FILE = resolve(KEYS_DIR, 'testnet.json');
/** Contract IDs and other public state written by deploy.ts and e2e.ts. */
export const TESTNET_STATE_FILE = resolve(REPO_ROOT, 'testnet-state.json');
/** Exported run logs (public tx hashes only). */
export const OUT_DIR = resolve(SCRIPTS_DIR, 'out');
/** Release Wasm built from `contracts/` by `stellar contract build` (Cargo workspace target dir). */
export const WASM_DIR = resolve(REPO_ROOT, 'contracts', 'target', 'wasm32v1-none', 'release');
