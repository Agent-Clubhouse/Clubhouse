import { spawnSync } from 'node:child_process';

const fixture = process.env.DEPENDABOT_PRECHECK_FIXTURE;
const result = fixture !== undefined
  ? { output: fixture, status: Number(process.env.DEPENDABOT_PRECHECK_STATUS ?? 0) }
  : (() => {
      const result = spawnSync(
        'npm',
        ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund', '--dry-run'],
        {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );

      if (result.error) {
        throw result.error;
      }

      return {
        output: [result.stdout, result.stderr].join('\n'),
        status: result.status ?? 1,
      };
    })();

const { output, status } = result;
const hasConflict = /ERESOLVE|peer dep|peer dependency|conflicting peer dependency/i.test(output);

if (status === 0) {
  console.log('Dependency resolution check passed: the install graph resolves cleanly.');
  process.exit(0);
}

const packageNames = [...new Set(
  [...output.matchAll(/(?:Found:|peer\s+|Could not resolve dependency:|requires\s+|from\s+)(@?[a-z0-9-~][a-z0-9-._~]*\/[a-z0-9-._~]+|[a-z0-9-._~]+)/gi)]
    .map((match) => match[1])
    .filter(Boolean),
)];

console.error(hasConflict
  ? 'Dependency resolution check failed: peer dependency conflict detected.'
  : `Dependency resolution check failed: npm exited with status ${status}.`);
if (packageNames.length > 0) {
  console.error(`Conflicting packages: ${packageNames.join(', ')}`);
}
console.error('--- npm output ---');
console.error(output.trim() || '(no output)');
process.exit(1);
