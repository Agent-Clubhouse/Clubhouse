import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const scriptPath = path.resolve('scripts/check-test-coverage-ratchet.mjs');
const marker = 'TODO' + '(TC-CRIT-03)';
let sandbox: string | undefined;

afterEach(() => {
  if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  sandbox = undefined;
});

describe('test coverage ratchet', () => {
  it('fails when marker occurrences exceed the baseline, including in one file', () => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-ratchet-test-'));
    execFileSync('git', ['init', '--quiet'], { cwd: sandbox });
    fs.writeFileSync(path.join(sandbox, 'example.ts'), `${marker}\n`.repeat(30));
    execFileSync('git', ['add', 'example.ts'], { cwd: sandbox });

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: sandbox,
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('marker count increased');
  });
});
