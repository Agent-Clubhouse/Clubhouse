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
  if (!fs.existsSync(FIXTURES_DIR)) return;

  const fixtures = fs.readdirSync(FIXTURES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(FIXTURES_DIR, d.name));

  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'E2E',
    GIT_AUTHOR_EMAIL: 'e2e@test.local',
    GIT_COMMITTER_NAME: 'E2E',
    GIT_COMMITTER_EMAIL: 'e2e@test.local',
  };

  for (const dir of fixtures) {
    const dotGit = path.join(dir, '.git');
    if (fs.existsSync(dotGit)) continue;

    try {
      execSync('git init', { cwd: dir, stdio: 'pipe', env: gitEnv });
      execSync('git add -A', { cwd: dir, stdio: 'pipe', env: gitEnv });
      execSync('git commit -m "e2e fixture init" --allow-empty', {
        cwd: dir,
        stdio: 'pipe',
        env: gitEnv,
      });
    } catch (err) {
      // Log but don't fail — the tests can still run without fixture repos
      console.warn(`[e2e global-setup] Failed to init git in ${path.basename(dir)}:`, String(err));
    }
  }
}
