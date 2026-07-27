/**
 * Playwright global teardown — clean up the .git directories created by
 * global-setup so they don't get accidentally committed, then (locally only)
 * reap any Electron instances the run orphaned.
 */

import * as fs from 'fs';
import * as path from 'path';
import { sweepE2EProcesses, isLocalRun } from './e2e-cleanup';

const FIXTURES_DIR = path.resolve(__dirname, 'fixtures');

export default function globalTeardown() {
  const fixtures = fs.readdirSync(FIXTURES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(FIXTURES_DIR, d.name));

  for (const dir of fixtures) {
    const dotGit = path.join(dir, '.git');
    if (fs.existsSync(dotGit)) {
      fs.rmSync(dotGit, { recursive: true, force: true });
    }
  }

  // Local only — CI runners are ephemeral and already upload test-results/.
  if (!isLocalRun()) return;
  const { killed, tempDirsRemoved } = sweepE2EProcesses();
  if (killed > 0 || tempDirsRemoved > 0) {
    console.log(`[e2e cleanup] reaped ${killed} orphaned process(es), removed ${tempDirsRemoved} temp dir(s)`);
  }
}
