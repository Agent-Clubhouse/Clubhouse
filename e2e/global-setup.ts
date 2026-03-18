/**
 * Playwright global setup — ensure E2E fixture directories are their own git
 * repos so that `git rev-parse --is-inside-work-tree` scopes to the fixture
 * rather than walking up to the CI checkout root (which triggers expensive
 * git operations against the entire monorepo).
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const FIXTURES_DIR = path.resolve(__dirname, 'fixtures');

export default function globalSetup() {
  const fixtures = fs.readdirSync(FIXTURES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(FIXTURES_DIR, d.name));

  for (const dir of fixtures) {
    const dotGit = path.join(dir, '.git');
    if (fs.existsSync(dotGit)) continue;

    // Initialize a minimal git repo so the fixture is self-contained
    execSync('git init', { cwd: dir, stdio: 'ignore' });
    execSync('git add -A', { cwd: dir, stdio: 'ignore' });
    execSync('git commit -m "e2e fixture init" --allow-empty', {
      cwd: dir,
      stdio: 'ignore',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'E2E',
        GIT_AUTHOR_EMAIL: 'e2e@test.local',
        GIT_COMMITTER_NAME: 'E2E',
        GIT_COMMITTER_EMAIL: 'e2e@test.local',
      },
    });
  }
}
