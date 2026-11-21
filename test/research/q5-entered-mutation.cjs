// In-memory one-guard mutation. Never writes source or uses app/provider data.
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const mode = process.argv[3];
if (!['guarded', 'remove-entered-guard'].includes(mode)) throw new Error('Unknown mutation mode');
require.extensions['.ts'] = (module, filename) => {
  let source = fs.readFileSync(filename, 'utf8');
  if (filename.endsWith(`${path.sep}journal.ts`)) {
    const guard = '&& this.enteredAttempts.has(delta.attemptId)';
    if (source.split(guard).length !== 2) throw new Error('Mutation target missing or ambiguous');
    if (mode === 'remove-entered-guard') source = source.replace(guard, '&& false');
  }
  module._compile(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, filename);
};
const { SequencedNoticeJournal } = require(path.resolve('src/main/services/group-project-notice-ledger/journal.ts'));
const recipient = { groupId: 'synthetic-group', host: null, agentId: 'synthetic-member', generation: 'generation-one' };
(async () => {
  const journal = await SequencedNoticeJournal.open({ directory: process.argv[2], recipient });
  await journal.append({ kind: 'initialize', recipient, baseline: 0 });
  const posts = [{ seq: 1, postId: 'synthetic-post-1' }];
  await journal.append({ kind: 'scan', through: 1, eligible: posts });
  await journal.append({ kind: 'intent', attemptId: 'attempt-1', posts, startedAt: 1 });
  const handle = journal.captureLiveHandoff('attempt-1');
  journal.markHandoffEntered(handle);
  journal.releaseLiveHandoff(handle);
  await journal.append({ kind: 'settle', attemptId: 'attempt-1', outcome: 'unsubmitted' });
  const state = journal.snapshot();
  if (state.pending[0].attemptId !== 'attempt-1' || state.attempts[0]?.status !== 'uncertain') {
    console.log('SAFETY ASSERTION FAILED: entered coverage became ready');
    process.exitCode = 2;
  } else console.log('Entered coverage remained uncertain; no resubmission permitted');
})().catch((error) => { console.error(error); process.exitCode = 1; });
