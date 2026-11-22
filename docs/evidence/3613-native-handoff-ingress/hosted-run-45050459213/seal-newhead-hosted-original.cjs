const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const root = 'node_modules/.cache/native-handoff-ingress';
const head = 'e83d9f27f0e6a85f3a2791b1eadb85995c6ae701';
const main = '70eff94e9042ccc304e68282e76afc9065497858';
const branch = 'lane-3613-p2-routes/native-ingress-hosted-45050459213';
const prefix = 'docs/evidence/3613-native-handoff-ingress/hosted-run-45050459213';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
assert.equal(git('rev-parse', 'HEAD'), head);
assert.equal(git('status', '--porcelain'), '');
assert.equal(git('ls-remote', 'origin', `refs/heads/${branch}`), '');
const run = JSON.parse(fs.readFileSync(`${root}/61-newhead-run-final-original.json`));
const terminal = JSON.parse(fs.readFileSync(`${root}/61-newhead-terminal-packet.json`));
const checkout = JSON.parse(fs.readFileSync(`${root}/62-newhead-checkout-commit-original.json`));
const pr = JSON.parse(fs.readFileSync(`${root}/62-newhead-pr-fresh-original.json`));
const selected = JSON.parse(fs.readFileSync(`${root}/63-newhead-junit-derived.json`));
assert.equal(run.status, 'completed'); assert.equal(run.conclusion, 'success');
assert.equal(run.head_sha, head); assert.equal(run.run_attempt, 1);
assert.equal(checkout.tree.sha, git('rev-parse', 'HEAD^{tree}'));
assert.deepEqual(checkout.parents.map(parent => parent.sha), [main, head]);
assert.deepEqual(terminal.counts, {success:33, skipped:4});
assert.equal(terminal.checkout.length, 33);
assert(terminal.checkout.every(row => row.sha === checkout.sha));
assert.equal(pr.headRefOid, head); assert.equal(pr.baseRefOid, main);
assert.equal(pr.state, 'OPEN'); assert.equal(pr.isDraft, false);
assert.equal(pr.mergeable, 'MERGEABLE'); assert.equal(pr.mergeStateStatus, 'CLEAN');
assert(pr.statusCheckRollup.every(check => check.status === 'COMPLETED' && ['SUCCESS','SKIPPED'].includes(check.conclusion)));
const entries = [];
const add = (name, bytes, raw = bytes) => entries.push({
  name, bytes, rawBytes:raw.length,
  rawSha256:crypto.createHash('sha256').update(raw).digest('hex'),
  storedSha256:crypto.createHash('sha256').update(bytes).digest('hex'),
});
for (const name of fs.readdirSync(root).filter(name => /^(?:58-before|59-|60-newhead-|61-newhead-|62-newhead-|63-newhead-|63-derivation)/.test(name)).sort()) {
  const file = path.join(root, name);
  if (!fs.statSync(file).isFile() || name === '61-newhead-logs-original.log' || name === '61-newhead-logs-original.log.gz') continue;
  add(name, fs.readFileSync(file));
}
const rawLog = fs.readFileSync(`${root}/61-newhead-logs-original.log`);
const storedLog = fs.readFileSync(`${root}/61-newhead-logs-original.log.gz`);
assert.deepEqual(zlib.gunzipSync(storedLog), rawLog);
add('61-newhead-logs-original.log.gz', storedLog, rawLog);
for (const shard of fs.readdirSync(`${root}/61-newhead-junit-original`).sort()) {
  const raw = fs.readFileSync(`${root}/61-newhead-junit-original/${shard}/test-results.xml`);
  const stored = zlib.gzipSync(raw);
  assert.deepEqual(zlib.gunzipSync(stored), raw);
  add(`junit/${shard}.xml.gz`, stored, raw);
}
for (const [name, file] of [
  ['README.md','newhead-hosted-note.md'],
  ['owner-watch-original.sh','watch-pr3778-newhead.sh'],
  ['junit-derivation-original.py','derive-newhead-junit.py'],
  ['seal-newhead-hosted-original.cjs','seal-newhead-hosted.cjs'],
]) add(name, fs.readFileSync(`${root}/${file}`));
const index = path.resolve(root, '64-newhead-hosted-seal.index');
assert(!fs.existsSync(index));
const env = {...process.env, GIT_INDEX_FILE:index};
const indexed = (...args) => execFileSync('git', args, {env,encoding:'utf8'}).trim();
indexed('read-tree', head);
for (const entry of entries) {
  entry.blob = execFileSync('git',['hash-object','-w','--stdin'],{input:entry.bytes,encoding:'utf8'}).trim();
  indexed('update-index','--add','--cacheinfo',`100644,${entry.blob},${prefix}/${entry.name}`);
}
const manifest = {
  at:new Date().toISOString(),sourceHead:head,sourceTree:checkout.tree.sha,run:run.id,event:run.event,attempt:run.run_attempt,
  conclusion:run.conclusion,counts:terminal.counts,checkout,
  freshPr:{number:pr.number,head:pr.headRefOid,base:pr.baseRefOid,state:pr.state,mergeable:pr.mergeable,mergeStateStatus:pr.mergeStateStatus},
  originalFailedRun:45046385831,originalFailedProof:'13703fdf4270684c83c1c24e144f6ed3c73d6e4c',
  approvedDeltaReview:'e4c5bd628ab919e599f2f06431714b494ee3b8d2',
  selectedPlatforms:selected.platforms,files:entries.map(({bytes,...entry})=>entry),
  limitations:'Actual hosted success; no merger/release or full-handoff acceptance. Local complete fixture types47/49 remain BOTHFAIL166 independently accepted scoped nonregression.247 legacy warnings separate71. Hosted reconnect cause unknown; all originals and human/product/protected boundaries preserved.',
};
const bytes = Buffer.from(JSON.stringify(manifest,null,2)+'\n');
const blob = execFileSync('git',['hash-object','-w','--stdin'],{input:bytes,encoding:'utf8'}).trim();
indexed('update-index','--add','--cacheinfo',`100644,${blob},${prefix}/manifest.json`);
const tree = indexed('write-tree');
const commit = git('commit-tree',tree,'-p',head,'-m','evidence(annex): seal exact PR3778 new-head hosted success\n\nCo-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>');
git('update-ref',`refs/heads/${branch}`,commit,'0000000000000000000000000000000000000000');
fs.unlinkSync(index);
git('push','--quiet','origin',`${commit}:refs/heads/${branch}`);
assert.equal(git('ls-remote','origin',`refs/heads/${branch}`).split(/\s+/)[0],commit);
assert.equal(git('rev-parse','HEAD'),head); assert.equal(git('status','--porcelain'),'');
const receipt = {at:new Date().toISOString(),commit,tree,branch,manifestBlob:blob,files:entries.length,prHeadUnchanged:head,prefix};
fs.writeFileSync(`${root}/64-newhead-hosted-readback.json`,JSON.stringify(receipt,null,2)+'\n');
console.log(JSON.stringify(receipt));
