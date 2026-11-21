// Isolated contract research only. Not imported by product or a ledger implementation.
// Measures local filesystem operations at proposed byte bounds; no correctness/SLA claim.
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'q5-contract-storage-'));
const samples = {};
const now = () => process.hrtime.bigint();
const elapsed = (start) => Number(now() - start) / 1e6;
let directoryFlush = 'supported in this run';
async function syncDirectory() {
  const handle = await fs.open(directory, 'r');
  try { await handle.sync(); }
  catch (error) {
    directoryFlush = `not established: ${error.code ?? error.name}`;
    throw error;
  } finally { await handle.close(); }
}
function syntheticJson(bytes, kind) {
  const base = JSON.stringify({ schemaVersion: 1, kind, synthetic: true, padding: '' });
  const value = JSON.stringify({ schemaVersion: 1, kind, synthetic: true, padding: 'x'.repeat(bytes - Buffer.byteLength(base)) });
  if (Buffer.byteLength(value) !== bytes) throw new Error('Incorrect research payload size');
  return value;
}
function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (fraction) => sorted[Math.ceil(sorted.length * fraction) - 1];
  return { count: sorted.length, minMs: sorted[0], medianMs: percentile(0.5), p95Ms: percentile(0.95), maxMs: sorted.at(-1), allMs: values };
}

// The 64KiB envelope includes digest/newline. It is synthetic, not a proposed wire encoding.
const payload = syntheticJson(64 * 1024 - 128, 'bounded-delta');
const digest = createHash('sha256').update(payload).digest('hex');
const framed = JSON.stringify({ digest, payload });
const record = Buffer.alloc(64 * 1024, 0x20);
if (Buffer.byteLength(framed) >= record.length) throw new Error('Research frame overflow');
record.write(framed); record[record.length - 1] = 0x0a;
const appendSamples = [];
for (let segment = 0; segment < 4; segment++) {
  const file = path.join(directory, `segment-${segment}.jsonl`);
  const handle = await fs.open(file, 'wx', 0o600);
  try {
    await syncDirectory();
    for (let index = 0; index < 8; index++) {
      const start = now();
      await handle.writeFile(record);
      await handle.sync();
      appendSamples.push(elapsed(start));
    }
  } finally { await handle.close(); }
  if ((await fs.stat(file)).size !== 512 * 1024) throw new Error('Research segment bound mismatch');
}
samples.append64KiBFileSync = summarize(appendSamples);

for (const bytes of [256 * 1024, 512 * 1024]) {
  const body = syntheticJson(bytes, 'bounded-checkpoint-page');
  const values = [];
  for (let index = 0; index < 12; index++) {
    const temporary = path.join(directory, `checkpoint-${bytes}.tmp`);
    const destination = path.join(directory, `checkpoint-${bytes}.json`);
    const start = now();
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(body); await handle.sync(); }
    finally { await handle.close(); }
    await fs.rename(temporary, destination);
    await syncDirectory();
    values.push(elapsed(start));
  }
  if ((await fs.stat(path.join(directory, `checkpoint-${bytes}.json`))).size !== bytes) throw new Error('Checkpoint bound mismatch');
  samples[`checkpoint${bytes / 1024}KiBRenameDirectorySync`] = summarize(values);
}

const oneHole = { uncertain: [{ seq: 1, postId: 'synthetic-uncertain-1' }], terminalCoverage: [[2, 1000001]] };
const hotBudget = 256;
const holes = Array.from({ length: 257 }, (_, index) => ({ seq: index * 2 + 1, postId: `synthetic-hole-${index}` }));
// Illustrates representation cost only. This does not exercise a product archive or restart.
const illustrativeSpill = { hot: holes.slice(-hotBudget), archived: holes.slice(0, -hotBudget), laterTerminalCoverage: [[515, 1000515]] };
const report = {
  kind: 'isolated-contract-byte-envelope-research',
  scope: 'synthetic append/checkpoint IO samples and illustrative JSON model; NOT product ledger, restart, compaction, latency SLA or power-loss proof',
  environment: { node: process.version, platform: process.platform, arch: process.arch, osRelease: os.release(), filesystem: 'default os.tmpdir filesystem; filesystem type not measured', directoryFlush },
  assumptions: { maxDeltaBytes: 65536, segmentBytes: 524288, pageBytes: [262144, 524288], samplesAppend: 32, samplesPerPageSize: 12, coldCacheControlled: false, concurrentLoadControlled: false },
  representation: { oneUncertainThenMillionTerminal: { bytes: Buffer.byteLength(JSON.stringify(oneHole)), holes: oneHole.uncertain.length, intervals: oneHole.terminalCoverage.length }, illustrative257Holes: { hot: illustrativeSpill.hot.length, archived: illustrativeSpill.archived.length, firstHoleRetained: illustrativeSpill.archived[0].seq === 1, encodedBytes: Buffer.byteLength(JSON.stringify(illustrativeSpill)) } },
  samples,
  artifactsDirectory: directory,
  artifactsRetained: true,
};
console.log(JSON.stringify(report, null, 2));
