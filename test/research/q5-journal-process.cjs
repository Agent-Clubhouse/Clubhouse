// Synthetic child-process crash fixture. No app/runtime/driver imports or live data.
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8');
  module._compile(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, filename);
};
const { SequencedNoticeJournal } = require(path.resolve('src/main/services/group-project-notice-ledger/journal.ts'));
const recipient = { groupId: 'synthetic-group', host: null, agentId: 'synthetic-member', generation: 'generation-one' };
let enabled = false;
const fault = process.argv[3];
(async () => {
  const journal = await SequencedNoticeJournal.open({ directory: process.argv[2], recipient, testFailure: async (point) => {
    if (!enabled) return;
    if (fault === 'partial-tail' && point === 'afterAppendBeforeSync') {
      const names = fs.readdirSync(process.argv[2]).filter((n) => /^journal-\d+\.log$/.test(n)).sort();
      const location = path.join(process.argv[2], names[names.length - 1]);
      fs.truncateSync(location, fs.statSync(location).size - 10);
      process.exit(77);
    }
    if (point === fault) process.exit(77);
  } });
  await journal.append({ kind: 'initialize', recipient, baseline: 0 });
  await journal.append({ kind: 'scan', through: 1, eligible: [{ seq: 1, postId: 'synthetic-post-1' }] });
  if (fault === 'afterPages' || fault === 'afterManifest') {
    await journal.append({ kind: 'intent', attemptId: 'attempt-1', posts: [{ seq: 1, postId: 'synthetic-post-1' }], startedAt: 1 });
    await journal.append({ kind: 'settle', attemptId: 'attempt-1', outcome: 'uncertain' });
    enabled = true; await journal.checkpoint();
  } else {
    enabled = true;
    await journal.append({ kind: 'intent', attemptId: 'attempt-1', posts: [{ seq: 1, postId: 'synthetic-post-1' }], startedAt: 1 });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
