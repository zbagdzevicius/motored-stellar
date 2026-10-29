// Repository hygiene for a public repo: no em dashes, no secret-shaped strings,
// no committed .env files, no business-confidential terms. The lint itself lives in
// scripts/lint/docs-lint.mjs (also run as `npm run lint:docs` and in CI).
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import { lintRepo as lint } from '../../../scripts/lint/docs-lint.mjs';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

describe('docs lint', () => {
  it('finds nothing in this repository', () => {
    const findings = lint(repoRoot);
    expect(findings.map((f) => `${f.file}:${f.line} [${f.rule}]`)).toEqual([]);
  });

  describe('catches each rule on a seeded tree', () => {
    const dir = mkdtempSync(join(tmpdir(), 'docs-lint-'));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    // Every bad string is assembled at runtime so this file passes the lint itself.
    const emDash = String.fromCharCode(0x2014);
    const secretShaped = 'S' + 'A'.repeat(55);
    const credential = ['API', '_KEY'].join('') + '=' + 'q'.repeat(24);
    const banned = ['Mango', 'Pay'].join('');

    writeFileSync(join(dir, 'a.md'), `one ${emDash} two\n`);
    writeFileSync(join(dir, 'b.ts'), `const k = "${secretShaped}";\n`);
    writeFileSync(join(dir, 'c.txt'), `${credential}\n`);
    writeFileSync(join(dir, 'd.md'), `paid via ${banned}\n`);
    writeFileSync(join(dir, '.env.local'), 'X=1\n');
    mkdirSync(join(dir, 'node_modules'));
    writeFileSync(join(dir, 'node_modules', 'ignored.md'), `${emDash}\n`);

    const rules = lint(dir).map((f) => `${f.file}:${f.rule}`).sort();

    it('flags em dashes, secret keys, credentials, banned terms and .env files', () => {
      expect(rules).toEqual([
        '.env.local:env-file',
        'a.md:em-dash',
        'b.ts:secret-key',
        'c.txt:credential',
        'd.md:banned-term',
      ]);
    });

    it('does not flag public keys, contract ids or ordinary words', () => {
      const ok = mkdtempSync(join(tmpdir(), 'docs-lint-ok-'));
      try {
        writeFileSync(
          join(ok, 'ok.md'),
          [
            'G' + 'B'.repeat(55),
            'C' + 'D'.repeat(55),
            'evaluation and an en dash – are fine',
            'API_KEY=<your key>',
          ].join('\n'),
        );
        expect(lint(ok)).toEqual([]);
      } finally {
        rmSync(ok, { recursive: true, force: true });
      }
    });
  });
});
