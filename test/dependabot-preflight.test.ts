import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const scriptPath = path.resolve('scripts/dependabot-preflight.mjs');

describe('dependabot dependency preflight', () => {
  it('passes when npm resolves the dependency graph', () => {
    const result = spawnSync(process.execPath, [scriptPath], {
      encoding: 'utf8',
      env: {
        ...process.env,
        DEPENDABOT_PRECHECK_FIXTURE: 'npm notice created a lockfile\nadded 42 packages\n',
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Dependency resolution check passed');
  });

  it('fails with the conflicting package names when a peer dependency conflict appears', () => {
    const result = spawnSync(process.execPath, [scriptPath], {
      encoding: 'utf8',
      env: {
        ...process.env,
        DEPENDABOT_PRECHECK_FIXTURE: `npm ERR! code ERESOLVE
npm ERR! While resolving: clubhouse@0.41.0
npm ERR! Found: @electron/fuses@1.8.0
npm ERR! Could not resolve dependency:
npm ERR! peer @electron/fuses@"^2.0.0" from @electron-forge/plugin-fuses@7.11.2
npm ERR! Fix the upstream dependency graph to avoid a broken lockfile.
`,
        DEPENDABOT_PRECHECK_STATUS: '1',
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('@electron/fuses');
    expect(result.stderr).toContain('@electron-forge/plugin-fuses');
    expect(result.stderr).toContain('peer dependency conflict detected');
  });
});
