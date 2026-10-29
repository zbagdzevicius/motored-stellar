#!/usr/bin/env node
// Repository lint for a public, testnet-only repo.
//
// Fails (exit 1) when any tracked text file contains:
//   1. an em dash (U+2014). House style is plain hyphens, commas and colons;
//   2. a string shaped like a Stellar secret key: "S" followed by 55 base32 characters;
//   3. a committed .env file, or an assignment that looks like a real credential value;
//   4. a banned term (business-confidential words that must never appear in this repo).
//
// Usage: node scripts/lint/docs-lint.mjs [rootDir]
// Exported `lintRepo(root)` returns the findings so tests can call it directly.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Directories never scanned (build output, dependencies, local key material). */
const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'target', 'dist', 'coverage', '.keys', '.stellar', '.turbo',
]);

/** Extensions treated as binary or generated and skipped. */
const SKIP_EXT = /\.(wasm|png|jpe?g|gif|ico|pdf|mp4|webm|woff2?|ttf|lock|tsbuildinfo)$/i;
const SKIP_FILES = new Set(['package-lock.json', 'Cargo.lock']);

const EM_DASH = String.fromCharCode(0x2014);

/** Stellar secret seed strkey: version byte "S", 56 chars of RFC 4648 base32. */
const SECRET_KEY = /(?<![A-Z2-7])S[A-Z2-7]{55}(?![A-Z2-7])/g;

/** KEY=value or "key": "value" where the key names a credential and the value looks real. */
const CREDENTIAL_ASSIGNMENT =
  /\b[A-Z0-9_]*(SECRET|PRIVATE_KEY|API_KEY|APIKEY|PASSWORD|MNEMONIC|SEED_PHRASE|ACCESS_TOKEN)[A-Z0-9_]*\s*[:=]\s*["']?(?!<|\$\{|process\.env|TODO|example|changeme|xxx)[A-Za-z0-9+/_\-]{16,}/;

/** Credential-looking values that are obviously fixtures, not real secrets. */
const PLACEHOLDER_VALUE = /test|fake|dummy|example|placeholder|mock|sample/i;

// Banned terms are assembled at runtime so this file does not contain them literally.
const BANNED = [
  ['Mango', 'Pay'],
  ['Ant', 'ler'],
  ['G', 'MV'],
  ['valu', 'ation'],
].map((parts) => parts.join(''));
const BANNED_RE = new RegExp(`\\b(${BANNED.join('|')})\\b`, 'i');

/** Recursively list files under `dir`, skipping SKIP_DIRS. */
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(name)) walk(full, out);
    } else if (st.isFile()) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Lint every text file under `root`.
 * @param {string} root
 * @returns {{ file: string, line: number, rule: string, text: string }[]}
 */
export function lintRepo(root) {
  const findings = [];
  for (const file of walk(root)) {
    const rel = relative(root, file).split(sep).join('/');
    const base = rel.split('/').pop() ?? rel;

    // .env files must never be committed. .gitignore covers them; this catches force-adds.
    if (/^\.env($|\.)/.test(base)) {
      findings.push({ file: rel, line: 0, rule: 'env-file', text: 'committed .env file' });
      continue;
    }
    if (SKIP_EXT.test(base) || SKIP_FILES.has(base)) continue;
    if (statSync(file).size > 2_000_000) continue;

    const content = readFileSync(file, 'utf8');
    if (content.includes('\u0000')) continue; // binary

    const lines = content.split(/\r?\n/);
    lines.forEach((text, i) => {
      const line = i + 1;
      if (text.includes(EM_DASH)) findings.push({ file: rel, line, rule: 'em-dash', text });
      SECRET_KEY.lastIndex = 0;
      if (SECRET_KEY.test(text)) findings.push({ file: rel, line, rule: 'secret-key', text: '<redacted>' });
      const cred = CREDENTIAL_ASSIGNMENT.exec(text);
      if (cred && !PLACEHOLDER_VALUE.test(cred[0].replace(/^[^:=]*[:=]/, ''))) findings.push({ file: rel, line, rule: 'credential', text: '<redacted>' });
      const banned = BANNED_RE.exec(text);
      if (banned) findings.push({ file: rel, line, rule: 'banned-term', text: banned[0] });
    });
  }
  return findings;
}

// CLI entry point.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = process.argv[2] ?? join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
  const findings = lintRepo(root);
  for (const f of findings) {
    console.error(`${f.file}:${f.line}  [${f.rule}]  ${f.text.slice(0, 160)}`);
  }
  if (findings.length > 0) {
    console.error(`\ndocs-lint: ${findings.length} finding(s)`);
    process.exit(1);
  }
  console.log('docs-lint: clean');
}
