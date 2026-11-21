// Synthetic files only. Frozen legacy source is executed, not approximated.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const ts = require('typescript');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const root = process.cwd();
const ledger = path.join(root, 'src/main/services/group-project-notice-ledger');
const fixture = path.join(root, 'test/research/fixtures/q5-legacy-71bd');
const meta = JSON.parse(fs.readFileSync(path.join(fixture, 'source.json'), 'utf8'));
const frozen = fs.readFileSync(path.join(fixture, 'journal.source.txt'));
if (sha(frozen) !== meta.sha256) throw new Error('Frozen legacy source hash mismatch');
for (const [file, expected] of Object.entries(meta.dependencies)) if (sha(fs.readFileSync(path.join(root, file))) !== expected) throw new Error(`Frozen legacy dependency mismatch: ${file}`);
require.extensions['.ts'] = (m, filename) => m._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, filename);
const virtual = path.join(ledger, '__q5-frozen-71bd.ts');
const original = new Module(virtual, module); original.filename = virtual; original.paths = Module._nodeModulePaths(ledger);
original._compile(ts.transpileModule(frozen.toString('utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, virtual);
const { SequencedNoticeJournal } = original.exports;
const { NoticeJournalOwner } = require(path.join(ledger, 'journal.ts'));
function check(value, message) { if (!value) throw new Error(`BYTE BRIDGE ASSERTION FAILED: ${message}`); }
const recipient = { groupId: 'synthetic-group', host: null, agentId: 'synthetic-agent', generation: 'synthetic-generation' };
const p = (seq) => ({ seq, postId: `synthetic-${seq}` });
const directory = process.argv[2];
if (!directory || !path.isAbsolute(directory)) throw new Error('Explicit synthetic directory required');
async function files() {
  const result = {};
  for (const name of (await fsp.readdir(directory)).sort()) if ((await fsp.lstat(path.join(directory, name))).isFile()) result[name] = sha(await fsp.readFile(path.join(directory, name)));
  return result;
}
(async () => {
  const old = await SequencedNoticeJournal.open({ directory, recipient });
  await old.append({ kind: 'initialize', recipient, baseline: 0 });
  for (const seq of [1, 2]) {
    await old.append({ kind: 'scan', through: seq, eligible: [p(seq)] });
    await old.append({ kind: 'intent', attemptId: `attempt-${seq}`, posts: [p(seq)], startedAt: 1 });
    const h = old.captureLiveHandoff(`attempt-${seq}`); old.markHandoffEntered(h);
    if (seq === 1) await old.append({ kind: 'settle', attemptId: 'attempt-1', outcome: 'uncertain' });
    else await old.acknowledgeLiveHandoff(h);
  }
  await old.checkpoint();
  // Offline future-compatible fixture data, accepted by BOTH readers. No old
  // instance writes again after this point; the comparison is single-writer.
  const manifestPath = path.join(directory, 'manifest.json');
  const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
  const top = JSON.parse(await fsp.readFile(path.join(directory, `page-${manifest.checkpointRoot}.json`), 'utf8'));
  check(top.kind === 'index', 'expected small real checkpoint index');
  for (let i = 0; i < top.children.length; i++) {
    const page = JSON.parse(await fsp.readFile(path.join(directory, `page-${top.children[i]}.json`), 'utf8'));
    if (page.kind !== 'metadata') continue;
    page.value.futureCheckpointOptional = { retained: 'synthetic' };
    const bytes = Buffer.from(JSON.stringify(page)); const hash = sha(bytes);
    await fsp.writeFile(path.join(directory, `page-${hash}.json`), bytes); top.children[i] = hash;
  }
  const topBytes = Buffer.from(JSON.stringify(top)); const topHash = sha(topBytes);
  await fsp.writeFile(path.join(directory, `page-${topHash}.json`), topBytes);
  manifest.checkpointRoot = topHash; manifest.futureOptional = { retained: true }; manifest.profile = { opaqueLegacyExtension: true };
  await fsp.writeFile(manifestPath, JSON.stringify(manifest));
  const oldReader = await SequencedNoticeJournal.open({ directory, recipient });
  const expected = oldReader.snapshot(); const before = await files();
  const current = await NoticeJournalOwner.openLegacy({ directory, recipient });
  try {
    check(JSON.stringify(current.snapshot()) === JSON.stringify(expected), 'new reader differs from actual old reader');
    check(JSON.stringify(await files()) === JSON.stringify(before), 'read-only new open rewrote compatible legacy bytes');
    const startRevision = current.committedRevision; const startDigest = manifest.checkpointDigest;
    await current.append({ kind: 'scan', through: 3, eligible: [p(3)] });
    await current.append({ kind: 'intent', attemptId: 'attempt-3', posts: [p(3)], startedAt: 1 });
    const h = await current.captureLiveHandoff('attempt-3'); current.tryMarkHandoffEntered(h);
    await current.acknowledgeLiveHandoff(h);
    let revision = startRevision; let previousDigest = startDigest; let records = 0;
    const segments = (await fsp.readdir(directory)).filter((n) => /^journal-\d+\.log$/.test(n)).sort();
    for (const segment of segments) {
      const body = await fsp.readFile(path.join(directory, segment)); let offset = 0;
      while (offset < body.length) {
        const length = body.readUInt32BE(offset); const payload = body.subarray(offset + 4, offset + 4 + length);
        const record = JSON.parse(payload.toString('utf8')); let delta;
        if (records === 0) delta = { kind: 'scan', through: 3, eligible: [p(3)] };
        else if (records === 1) {
          check(typeof record.delta.handoffProcess === 'string', 'missing actual process data');
          delta = { kind: 'intent', attemptId: 'attempt-3', posts: [p(3)], startedAt: 1, handoffProcess: record.delta.handoffProcess };
        } else delta = { kind: 'settle', attemptId: 'attempt-3', outcome: 'accepted', acknowledgement: { kind: 'same-process-exact-handoff', handoffProcess: record.delta.acknowledgement.handoffProcess, coverageDigest: sha(JSON.stringify([[3, 'synthetic-3']])) } };
        const encoded = Buffer.from(JSON.stringify({ schemaVersion: 1, minWriterVersion: 1, revision: ++revision, previousDigest, delta }));
        check(payload.equals(encoded), 'new canonical legacy payload bytes/field order differ');
        check(body.subarray(offset + 4 + length, offset + 36 + length).toString('hex') === sha(encoded), 'new canonical checksum differs');
        previousDigest = sha(encoded); offset += length + 36; records++;
      }
    }
    check(records === 3, 'unexpected transaction count');
    const after = current.snapshot(); await current.checkpoint(); await current.close();
    const oldAfter = await SequencedNoticeJournal.open({ directory, recipient });
    check(JSON.stringify(oldAfter.snapshot()) === JSON.stringify(after), 'actual old reader rejected or changed new state');
    const saved = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
    check(saved.futureOptional.retained === true && saved.profile.opaqueLegacyExtension === true, 'opaque legacy manifest fields lost');
    check(oldAfter.snapshot().futureCheckpointOptional.retained === 'synthetic', 'optional checkpoint data lost');
    console.log(JSON.stringify({ originalSource: meta.source, originalSha256: meta.sha256, records, oldToNew: true, newToOld: true, openBytesUnchanged: true, payloadBytesExact: true, optionalFieldsRetained: true, acceptedCount: after.acceptedCount, uncertainCount: after.attempts.length }));
  } finally { await current.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
