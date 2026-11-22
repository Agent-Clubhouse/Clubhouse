#!/usr/bin/env bash
set -u
set -o pipefail

root="node_modules/.cache/native-handoff-ingress"
run=45046385831
repo=Agent-Clubhouse/Clubhouse
capture() {
  local name="$1"
  shift
  "$@" > "$root/$name" 2> "$root/$name.stderr"
  local result=$?
  printf '%s\t%s\n' "$name" "$result" >> "$root/39-capture-exits-original.tsv"
  return "$result"
}

capture 39-run-initial-original.json gh api "repos/$repo/actions/runs/$run" || exit 91
capture 39-merge-ref-initial-original.json gh api "repos/$repo/git/ref/pull/3778/merge" || exit 92
node <<'NODE' || exit 93
const fs = require('node:fs');
const assert = require('node:assert/strict');
const p = 'node_modules/.cache/native-handoff-ingress/';
const run = JSON.parse(fs.readFileSync(p + '39-run-initial-original.json'));
assert.equal(run.id, 45046385831);
assert.equal(run.head_sha, '206a88dcc93ecd7d2f5009d533894dd77e36e2ed');
assert.equal(run.event, 'pull_request');
assert.equal(run.run_attempt, 1);
assert(run.pull_requests.some(pr => pr.number === 3778));
console.log(JSON.stringify({watching:run.id, head:run.head_sha, attempt:run.run_attempt, status:run.status}));
NODE

printf 'Owner PID: %s\n' "$$" | tee "$root/39-watch-owner-original.txt"
gh run watch "$run" --repo "$repo" --interval 60 --exit-status > "$root/39-watch-original.log" 2>&1
watch_result=$?
printf '%s\n' "$watch_result" > "$root/39-watch-exit-original.txt"
printf 'Terminal watcher exit: %s\n' "$watch_result"

capture 40-run-final-original.json gh api "repos/$repo/actions/runs/$run"
run_capture=$?
capture 40-jobs-final-original.json gh api --paginate --slurp "repos/$repo/actions/runs/$run/jobs?filter=latest&per_page=100"
jobs_capture=$?
capture 40-pr-final-original.json gh pr view 3778 --repo "$repo" --json number,url,state,headRefOid,baseRefOid,mergeable,mergeStateStatus,statusCheckRollup,reviewDecision
pr_capture=$?
capture 40-logs-original.log gh run view "$run" --repo "$repo" --log
logs_capture=$?
capture 40-refs-final-original.txt git ls-remote origin refs/heads/main refs/heads/lane-3613-p2-routes/handoff-next-path
refs_capture=$?

if [ "$run_capture" -ne 0 ] || [ "$jobs_capture" -ne 0 ] || [ "$pr_capture" -ne 0 ] || [ "$logs_capture" -ne 0 ] || [ "$refs_capture" -ne 0 ]; then
  printf 'Capture failure: run=%s jobs=%s pr=%s logs=%s refs=%s; originals retained\n' "$run_capture" "$jobs_capture" "$pr_capture" "$logs_capture" "$refs_capture"
  exit 94
fi

node <<'NODE'
const fs = require('node:fs');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const p = 'node_modules/.cache/native-handoff-ingress/';
const read = name => JSON.parse(fs.readFileSync(p + name));
const run = read('40-run-final-original.json');
const pr = read('40-pr-final-original.json');
const jobs = read('40-jobs-final-original.json').flatMap(page => page.jobs);
const log = fs.readFileSync(p + '40-logs-original.log', 'utf8');
const lines = log.split('\n');
const checkout = [];
for (let index = 0; index < lines.length - 1; index++) {
  if (/git(?:\.exe)? log -1 --format=%H/.test(lines[index])) {
    const hash = lines[index + 1].match(/\b[0-9a-f]{40}\b/);
    if (hash) checkout.push({job:lines[index].split('\t')[0], sha:hash[0], commandLine:index + 1, resultLine:index + 2});
  }
}
assert.equal(run.id, 45046385831);
assert.equal(run.head_sha, '206a88dcc93ecd7d2f5009d533894dd77e36e2ed');
assert.equal(run.event, 'pull_request');
assert.equal(run.run_attempt, 1);
assert.equal(run.status, 'completed');
assert.equal(pr.headRefOid, run.head_sha);
assert(jobs.every(job => job.status === 'completed'));
const counts = jobs.reduce((out, job) => {
  out[job.conclusion] = (out[job.conclusion] || 0) + 1;
  return out;
}, {});
const packet = {
  at:new Date().toISOString(), run:run.id, url:run.html_url,
  head:run.head_sha, status:run.status, conclusion:run.conclusion,
  attempt:run.run_attempt, event:run.event,
  startedAt:run.run_started_at, updatedAt:run.updated_at,
  pr:{number:pr.number, head:pr.headRefOid, base:pr.baseRefOid, state:pr.state, mergeable:pr.mergeable, mergeStateStatus:pr.mergeStateStatus, reviewDecision:pr.reviewDecision},
  counts, jobs:jobs.map(job => ({id:job.id, name:job.name, status:job.status, conclusion:job.conclusion, startedAt:job.started_at, completedAt:job.completed_at, url:job.html_url})),
  checkout, checkoutObserved:checkout.length > 0,
  originalLog:{bytes:Buffer.byteLength(log),sha256:crypto.createHash('sha256').update(log).digest('hex')},
  watcherExit:Number(fs.readFileSync(p + '39-watch-exit-original.txt', 'utf8'))
};
fs.writeFileSync(p + '40-terminal-packet.json', JSON.stringify(packet, null, 2) + '\n');
console.log(JSON.stringify({run:packet.run, head:packet.head, conclusion:packet.conclusion, counts, checkout}));
NODE
packet_result=$?
gzip -c "$root/40-logs-original.log" > "$root/40-logs-original.log.gz"
gzip_result=$?
if [ "$packet_result" -ne 0 ] || [ "$gzip_result" -ne 0 ]; then
  printf 'Packet/gzip failure: %s/%s; originals retained\n' "$packet_result" "$gzip_result"
  exit 95
fi
exit "$watch_result"
