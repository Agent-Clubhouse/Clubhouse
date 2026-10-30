#!/usr/bin/env node
/**
 * Regenerates the canonical Annex mobile protocol fixtures
 * (test/fixtures/annex-mobile/) from the real annex-server code, or with
 * `--check` fails when they are stale. The phone (Clubhouse Go) vendors these
 * files for its contract tests; see docs/mobile-control-v1.md#contract-fixtures.
 *
 *   npm run fixtures:annex-mobile             # rewrite the fixtures
 *   npm run fixtures:annex-mobile -- --check  # fail if they would change
 */
import { spawnSync } from 'node:child_process';

const check = process.argv.includes('--check');
const result = spawnSync('npx', ['vitest', 'run', '--project', 'main', 'src/main/services/annex-mobile-contract.test.ts'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, ANNEX_MOBILE_FIXTURES: check ? 'check' : 'write' },
});
process.exit(result.status ?? 1);
