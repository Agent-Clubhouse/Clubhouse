import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ESLint } from 'eslint';

const base = 'c43ffb37d20650c542e449a8a04a9fd84e65b655';
const files = [
  'src/main/services/annex-client.ts',
  'src/main/services/annex-client.test.ts',
  'src/main/services/annex-client-buffer.test.ts',
  'src/main/services/annex-devices.ts',
  'src/main/services/annex-devices.test.ts',
  'src/main/services/remote-icon-fetch.ts',
];
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
for (const file of ['eslint.config.mjs', 'package.json', 'package-lock.json']) {
  if (sha(readFileSync(file)) !== sha(execFileSync('git', ['show', `${base}:${file}`]))) {
    throw new Error(`Baseline policy or dependency input changed: ${file}`);
  }
}
const eslint = new ESLint();
const report = [];
for (const file of files) {
  const before = git('show', `${base}:${file}`);
  const after = readFileSync(file, 'utf8');
  const hunks = [...git('diff', '--unified=0', base, '--', file).matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)]
    .map((m) => ({ oldStart: Number(m[1]), oldCount: Number(m[2] ?? 1), newStart: Number(m[3]), newCount: Number(m[4] ?? 1) }));
  const originalLine = (line) => {
    let delta = 0;
    for (const hunk of hunks) {
      if (hunk.newCount && line >= hunk.newStart && line < hunk.newStart + hunk.newCount) return null;
      if (hunk.newCount ? line >= hunk.newStart + hunk.newCount : line > hunk.newStart) delta += hunk.oldCount - hunk.newCount;
    }
    return line + delta;
  };
  const [baseline] = await eslint.lintText(before, { filePath: file });
  const [current] = await eslint.lintText(after, { filePath: file });
  const key = (message, line) => JSON.stringify([line, message.column, message.ruleId, message.severity, message.message]);
  const retained = new Set(baseline.messages.map((message) => key(message, message.line)));
  const introduced = current.messages.filter((message) => !retained.has(key(message, originalLine(message.line))));
  report.push({
    file, base, beforeSha256: sha(before), afterSha256: sha(after),
    baselineErrors: baseline.errorCount, baselineWarnings: baseline.warningCount,
    currentErrors: current.errorCount, currentWarnings: current.warningCount,
    introduced, baselineMessages: baseline.messages, currentMessages: current.messages,
  });
}
const totals = {
  base,
  baselineWarnings: report.reduce((count, file) => count + file.baselineWarnings, 0),
  currentWarnings: report.reduce((count, file) => count + file.currentWarnings, 0),
  currentErrors: report.reduce((count, file) => count + file.currentErrors, 0),
  introducedDiagnostics: report.reduce((count, file) => count + file.introduced.length, 0),
};
console.log(JSON.stringify({ ...totals, files: report }, null, 2));
console.log(`Lint totals: ${JSON.stringify(totals)}`);
if (report.some((file) => file.currentErrors || file.introduced.length)) process.exitCode = 1;
