// Narrow exact-source mutations, compiled only in memory; no app/driver imports.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const { spawnSync, execFileSync } = require('node:child_process');
const sourceFile = path.resolve('src/main/services/group-project-notice-ledger/journal.ts');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const mode = process.argv[2];
const fixtureBefore = sha(fs.readFileSync(__filename));
const sourceBefore = sha(fs.readFileSync(sourceFile));

if (!mode) {
  console.log(JSON.stringify({ head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), fixtureSha256: fixtureBefore, originalJournalSha256: sourceBefore }));
  const expected = { guarded: 0, 'queued-only-hold': 2, 'remove-attempt-entry-check': 2 };
  let failure = false;
  for (const [mutation, status] of Object.entries(expected)) {
    const result = spawnSync(process.execPath, [__filename, mutation], { encoding: 'utf8', cwd: process.cwd() });
    console.log(JSON.stringify({ mutation, expectedExit: status, actualExit: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr }));
    if (result.error || result.signal || result.status !== status) failure = true;
    if (mutation === 'queued-only-hold' && (!result.stdout.includes('FAILED: uncertain admitted immediate entry') || !result.stdout.includes('FAILED: recover admitted immediate entry'))) failure = true;
    if (mutation === 'remove-attempt-entry-check' && !result.stdout.includes('FAILED: duplicate handle entered')) failure = true;
  }
  const fixtureAfter = sha(fs.readFileSync(__filename));
  const sourceAfter = sha(fs.readFileSync(sourceFile));
  console.log(JSON.stringify({ fixtureAfter, sourceAfter, unchanged: fixtureAfter === fixtureBefore && sourceAfter === sourceBefore }));
  process.exitCode = failure || fixtureAfter !== fixtureBefore || sourceAfter !== sourceBefore ? 1 : 0;
} else {
  if (!['guarded', 'queued-only-hold', 'remove-attempt-entry-check'].includes(mode)) throw new Error('Unknown mutation');
  const ts = createRequire(path.join(process.cwd(), 'package.json'))('typescript');
  const replaceOnce = (source, from, to) => {
    if (source.split(from).length !== 2) throw new Error('Mutation target missing or ambiguous');
    return source.replace(from, to);
  };
  require.extensions['.ts'] = (module, filename) => {
    let source = fs.readFileSync(filename, 'utf8');
    if (filename === sourceFile) {
      if (mode === 'queued-only-hold') {
        source = replaceOnce(source,
          '    if (settling) this.settlingAttempts.set(settling, (this.settlingAttempts.get(settling) ?? 0) + 1);\n    if (recovery) this.pendingRecoveries++;', '');
        source = replaceOnce(source, '    const next = this.work.catch(() => {}).then(async () => {',
          "    const next = this.work.catch(() => {}).then(async () => {\n      if (input.kind === 'settle' && input.outcome !== 'accepted') this.settlingAttempts.set(input.attemptId, (this.settlingAttempts.get(input.attemptId) ?? 0) + 1);\n      if (input.kind === 'recover') this.pendingRecoveries++;");
      }
      if (mode === 'remove-attempt-entry-check') source = replaceOnce(source, ' || this.enteredAttempts.has(proof.attemptId)', '');
      console.log(JSON.stringify({ mode, originalJournalSha256: sourceBefore, compiledJournalSha256: sha(source) }));
    }
    module._compile(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, filename);
  };
  const { SequencedNoticeJournal } = require(sourceFile);
  const recipient = { groupId: 'synthetic-group', host: null, agentId: 'synthetic-member', generation: 'generation-one' };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'q5-entry-mutation-'));
  const prepare = async (name) => {
    const journal = await SequencedNoticeJournal.open({ directory: path.join(root, name), recipient });
    await journal.append({ kind: 'initialize', recipient, baseline: 0 });
    const posts = [{ seq: 1, postId: 'synthetic-post-1' }];
    await journal.append({ kind: 'scan', through: 1, eligible: posts });
    await journal.append({ kind: 'intent', attemptId: 'attempt-1', posts, startedAt: 1 });
    return journal;
  };
  (async () => {
    const journal = await prepare('duplicate');
    const first = journal.captureLiveHandoff('attempt-1');
    const second = journal.captureLiveHandoff('attempt-1');
    journal.markHandoffEntered(first);
    let duplicateEntered = false;
    try { journal.markHandoffEntered(second); duplicateEntered = true; }
    catch { /* Expected modeled refusal is the behavior under test. */ }
    if (duplicateEntered) { console.log('FAILED: duplicate handle entered'); process.exitCode = 2; }
    else console.log('PASS: duplicate handle refused');
    for (const kind of ['uncertain', 'recover']) {
      const journal = await prepare(kind);
      const handle = journal.captureLiveHandoff('attempt-1');
      const transition = journal.append(kind === 'recover' ? { kind: 'recover' } : { kind: 'settle', attemptId: 'attempt-1', outcome: 'uncertain' });
      // Intentionally NO await before entry: distinguishes request-time hold
      // from an otherwise identical hold in the queued callback.
      let entered = false;
      try { journal.markHandoffEntered(handle); entered = true; }
      catch { /* Expected modeled refusal is the behavior under test. */ }
      await transition;
      if (entered) { console.log(`FAILED: ${kind} admitted immediate entry`); process.exitCode = 2; }
      else console.log(`PASS: ${kind} refused immediate entry`);
    }
  })().catch((error) => { console.error(error); process.exitCode = 1; })
    .finally(() => fs.rmSync(root, { recursive: true, force: true }));
}
