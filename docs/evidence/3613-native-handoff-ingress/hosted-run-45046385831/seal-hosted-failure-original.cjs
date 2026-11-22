const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const root = 'node_modules/.cache/native-handoff-ingress';
const head = '206a88dcc93ecd7d2f5009d533894dd77e36e2ed';
const branch = 'lane-3613-p2-routes/native-ingress-hosted-45046385831';
const prefix = 'docs/evidence/3613-native-handoff-ingress/hosted-run-45046385831';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
assert.equal(git('rev-parse', 'HEAD'), head);
assert.equal(git('status', '--porcelain'), '');
assert.equal(git('ls-remote', 'origin', `refs/heads/${branch}`), '');
const run = JSON.parse(fs.readFileSync(`${root}/40-run-final-original.json`));
assert.equal(run.status, 'completed');
assert.equal(run.conclusion, 'failure');
assert.equal(run.head_sha, head);
assert.equal(run.run_attempt, 1);
const checkout = JSON.parse(fs.readFileSync(`${root}/41-actual-checkout-commit-original.json`));
assert.equal(checkout.tree.sha, git('rev-parse', 'HEAD^{tree}'));
assert.deepEqual(checkout.parents.map(parent => parent.sha), ['70eff94e9042ccc304e68282e76afc9065497858', head]);
const entries = [];
const add = (name, bytes, raw = bytes) => {
  entries.push({
    name, bytes, rawBytes: raw.length,
    rawSha256: crypto.createHash('sha256').update(raw).digest('hex'),
    storedSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  });
};
for (const name of fs.readdirSync(root).filter(name => /^(?:34-|35-|36-|37-|38-|39-|40-|41-|42-hosted-artifacts|43-junit-derived|43-checkouts-derived)/.test(name)).sort()) {
  const file = path.join(root, name);
  if (!fs.statSync(file).isFile() || name === '40-logs-original.log' || name === '40-logs-original.log.gz') continue;
  add(name, fs.readFileSync(file));
}
const rawLog = fs.readFileSync(`${root}/40-logs-original.log`);
const storedLog = fs.readFileSync(`${root}/40-logs-original.log.gz`);
assert.deepEqual(zlib.gunzipSync(storedLog), rawLog);
add('40-logs-original.log.gz', storedLog, rawLog);
for (const shard of fs.readdirSync(`${root}/42-hosted-junit-original`).sort()) {
  const raw = fs.readFileSync(`${root}/42-hosted-junit-original/${shard}/test-results.xml`);
  const stored = zlib.gzipSync(raw);
  assert.deepEqual(zlib.gunzipSync(stored), raw);
  add(`junit/${shard}.xml.gz`, stored, raw);
}
for (const [name, file] of [['README.md', 'hosted-failure-note.md'], ['owner-watch-original.sh', 'watch-pr3778.sh'], ['seal-hosted-failure-original.cjs', 'seal-hosted-failure.cjs'], ['junit-derivation-original.py', 'derive-hosted-junit.py']]) {
  add(name, fs.readFileSync(`${root}/${file}`));
}
const index = path.resolve(root, '43-hosted-seal.index');
assert(!fs.existsSync(index));
const env = { ...process.env, GIT_INDEX_FILE: index };
const indexed = (...args) => execFileSync('git', args, { env, encoding: 'utf8' }).trim();
indexed('read-tree', head);
for (const entry of entries) {
  entry.blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { input: entry.bytes, encoding: 'utf8' }).trim();
  indexed('update-index', '--add', '--cacheinfo', `100644,${entry.blob},${prefix}/${entry.name}`);
}
const manifest = {
  at: new Date().toISOString(), sourceHead: head, originalRun: run.id,
  conclusion: run.conclusion, actualCheckout: checkout,
  files: entries.map(({ bytes, ...entry }) => entry),
  limitations: 'One failed automatic attempt. Original raw/gzip logs and four JUnit artifacts. Proper XML metadata derivation only; no rerun or successor-source execution.',
};
const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
const manifestBlob = execFileSync('git', ['hash-object', '-w', '--stdin'], { input: manifestBytes, encoding: 'utf8' }).trim();
indexed('update-index', '--add', '--cacheinfo', `100644,${manifestBlob},${prefix}/manifest.json`);
const tree = indexed('write-tree');
const commit = git('commit-tree', tree, '-p', head, '-m', 'evidence(annex): preserve original PR3778 hosted failure and checkout\n\nCo-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>');
git('update-ref', `refs/heads/${branch}`, commit, '0000000000000000000000000000000000000000');
fs.unlinkSync(index);
git('push', '--quiet', 'origin', `${commit}:refs/heads/${branch}`);
assert.equal(git('ls-remote', 'origin', `refs/heads/${branch}`).split(/\s+/)[0], commit);
assert.equal(git('rev-parse', 'HEAD'), head);
assert.equal(git('status', '--porcelain'), '');
const receipt = { at: new Date().toISOString(), commit, tree, branch, manifestBlob, files: entries.length, prHeadUnchanged: head, prefix };
fs.writeFileSync(`${root}/44-hosted-freeze-readback.json`, JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify(receipt));
