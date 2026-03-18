/**
 * Playwright global teardown — clean up the .git directories created by
 * global-setup so they don't get accidentally committed.
 */

import * as fs from 'fs';
import * as path from 'path';

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
}
