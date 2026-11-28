// Offline, single-process replay. Only git objects and synthetic local fixtures are read.
// Run from repository root: node docs/diagnostics/nov27-mobile-refresh/pair-replay.cjs
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { createHash } = require('node:crypto');
const ts = require(require.resolve('typescript', { paths: [process.cwd()] }));
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 }).trimEnd();
const base = __dirname;
const fixtureRoot = fs.mkdtempSync(path.join(base, 'pair-replay-fixture-'));
const revisions = { beta7: 'dc8e82236eb2ae8dadb6bd309297d0c157caaba4', beta8: '30fd3ab0fdca6dbe75aed0b91e4c9878eded9b71' };
const report = { generatedAt: new Date().toISOString(), node: process.version, typescript: ts.version,
  platform: `${process.platform}/${process.arch}`, singleProcess: true, repetitions: 3, limit: 50, releases: {} };
const round = n => Number(n.toFixed(3));

function releaseLoader(revision, userData, reads) {
  const cache = new Map(), hashes = {};
  const trackedFsp = { ...fsp, readFile: async (file, ...args) => {
    assert(path.resolve(String(file)).startsWith(userData + path.sep), 'fixture read escaped synthetic userData');
    const result = await fsp.readFile(file, ...args);
    reads.push({ name: path.basename(String(file)), bytes: Buffer.byteLength(result) });
    return result;
  } };
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports;
    const source = git('show', `${revision}:${file}`);
    hashes[file] = createHash('sha256').update(source).digest('hex');
    const module = { exports: {} }; cache.set(file, module);
    const localRequire = name => {
      if (name === 'electron') return { app: { getPath: key => { assert.equal(key, 'userData'); return userData; } } };
      if (name === '../log-service') return { appLog() {} };
      if (name === 'fs/promises') return trackedFsp;
      if (!name.startsWith('.')) {
        assert(['fs', 'path', 'crypto'].includes(name), `unexpected external import ${name}`);
        return require(name);
      }
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), name));
      // Resolve against the selected release's tree, never the working tree.
      const candidates = [target + '.ts', target + '/index.ts'];
      const resolved = candidates.find(candidate => {
        try { git('cat-file', '-e', `${revision}:${candidate}`); return true; } catch { return false; }
      });
      assert(resolved, `cannot resolve ${name} from ${file}`);
      return load(resolved);
    };
    const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    vm.runInThisContext(`(function(require,module,exports){${js}\n})`, { filename: `${revision}/${file}` })(localRequire, module, module.exports);
    return module.exports;
  }
  return { load, hashes };
}

(async () => {
  try {
    for (const [label, revision] of Object.entries(revisions)) {
      const userData = path.join(fixtureRoot, label); fs.mkdirSync(userData);
      const reads = [], loader = releaseLoader(revision, userData, reads);
      const storage = loader.load('src/main/services/agent-runtime/chat-transcript.ts');
      const { buildChatPage } = loader.load('src/main/services/annex-chat-pages.ts');
      const { groupChatEvents } = loader.load('src/shared/dispatcher-group-chat.ts');
      const dir = path.join(userData, 'agent-logs', 'chat', 'synthetic-agent'); fs.mkdirSync(dir, { recursive: true });
      const entries = [];
      for (const [sessionId, count] of [['small', 100], ['long', 20000]]) {
        const events = Array.from({ length: count }, (_, i) => ({ v: 2, agentId: 'synthetic-agent', sessionId,
          seq: i + 1, ts: i + 1, type: i % 2 ? 'agent_message' : 'agent_thought',
          data: { text: 'Synthetic offline diagnostic only. '.repeat(8), messageId: `m${i}` } }));
        const body = events.map(e => JSON.stringify(e)).join('\n') + '\n';
        fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), body);
        entries.push({ sessionId, bytes: Buffer.byteLength(body), startedAt: 1, lastActiveAt: count, lastSeq: count, eventCount: count });
      }
      fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ version: 1, currentSessionId: 'long', sessions: entries }));
      // Warm process index; measured reads below are unchanged selected-session reads.
      await storage.listChatSessions('synthetic-agent'); reads.length = 0;
      const cases = [];
      for (const entry of entries) for (const view of ['ordinary', 'dispatcher']) for (const page of ['latest', 'older']) {
        const samples = [];
        for (let repetition = 0; repetition < report.repetitions; repetition++) {
          reads.length = 0;
          const t0 = performance.now();
          const current = await storage.readChatTranscript('synthetic-agent', { sessionId: entry.sessionId });
          const t1 = performance.now();
          assert.equal(current.length, entry.eventCount);
          const shown = view === 'dispatcher' ? groupChatEvents(current, { ownAgentIds: new Set(['synthetic-agent']) }) : current;
          assert.equal(shown.length, entry.eventCount / (view === 'dispatcher' ? 2 : 1));
          const beforeSeq = page === 'older' ? entry.lastSeq - 50 : undefined;
          const eligible = shown.filter(e => beforeSeq === undefined || e.seq < beforeSeq);
          const result = buildChatPage({ eligible, limit: report.limit, pendingPermissions: [], pendingQuestions: [],
            metadata: { version: 1, epoch: 'synthetic', agentId: 'synthetic-agent', sessionId: entry.sessionId,
              lastSeq: current.at(-1).seq, readOnly: true, queuedMessageIds: [], queueStateSeq: 0 } });
          const t2 = performance.now();
          assert.equal(result.ok, true);
          const decoded = JSON.parse(result.body), expected = eligible.slice(-report.limit);
          assert.deepEqual(decoded.events.map(e => e.seq), expected.map(e => e.seq));
          assert.equal(decoded.truncated, eligible.length > report.limit);
          assert.equal(decoded.nextBeforeSeq, decoded.truncated ? expected[0].seq : null);
          assert.equal(decoded.lastSeq, entry.lastSeq);
          assert.deepEqual(reads, [{ name: `${entry.sessionId}.jsonl`, bytes: entry.bytes }]);
          samples.push({ readParseMs: round(t1 - t0), filterPageMs: round(t2 - t1), totalMs: round(t2 - t0),
            inputBytes: entry.bytes, responseBytes: Buffer.byteLength(result.body), returnedEvents: decoded.events.length });
        }
        cases.push({ session: entry.sessionId, rawEvents: entry.eventCount, view, page, samples });
      }
      storage.resetTranscriptCache();
      report.releases[label] = { revision, packageVersion: JSON.parse(git('show', `${revision}:package.json`)).version,
        loadedSourceSha256: loader.hashes, cases };
    }
    fs.writeFileSync(path.join(base, 'pair-replay-output.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ passed: true, releases: Object.keys(report.releases), cases: 16, measuredReads: 48,
      output: 'docs/diagnostics/nov27-mobile-refresh/pair-replay-output.json' }));
  } finally { fs.rmSync(fixtureRoot, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
