import * as path from 'path';
import { checkWindowsPaths } from '../scripts/ci/check-windows-paths.mjs';

/**
 * After the whole run, fail if anything under the repo can't exist on Windows.
 * A test run once left an `undefined\temp/` compile-cache dir that an agent
 * committed, breaking every Windows checkout (#2347).
 */
export default function setup(): () => void {
  return () => {
    const message = checkWindowsPaths(path.resolve(__dirname, '..'), { untracked: true });
    if (!message) return;
    // A throw here is only logged ("error during close"); the run still exits 0.
    console.error(`\n${message}\n`);
    process.exitCode = 1;
  };
}
