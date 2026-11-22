#!/usr/bin/env bash
set -u
set -o pipefail

root="node_modules/.cache/native-handoff-ingress"
repo=Agent-Clubhouse/Clubhouse
head=e83d9f27f0e6a85f3a2791b1eadb85995c6ae701
capture() {
  local name="$1"
  shift
  "$@" > "$root/$name" 2> "$root/$name.stderr"
  local result=$?
  printf '%s\t%s\n' "$name" "$result" >> "$root/60-newhead-capture-exits-original.tsv"
  return "$result"
}

printf 'Owner PID: %s\n' "$$" | tee "$root/60-newhead-watch-owner-original.txt"
run=""
for attempt in $(seq 1 20); do
  capture "60-newhead-discovery-$attempt-original.json" gh run list --repo "$repo" --branch lane-3613-p2-routes/handoff-next-path --event pull_request --workflow validate.yml --limit 5 --json databaseId,event,headSha,status,conclusion,url || exit 91
  run=$(node - "$root/60-newhead-discovery-$attempt-original.json" "$head" <<'NODE'
const fs = require('node:fs');
const assert = require('node:assert/strict');
const candidates = JSON.parse(fs.readFileSync(process.argv[2])).filter(run => run.headSha === process.argv[3]);
assert(candidates.length <= 1, 'Multiple automatic runs at the approved head require disposition');
if (candidates.length === 1) console.log(candidates[0].databaseId);
NODE
  ) || exit 92
  if [ -n "$run" ]; then break; fi
  printf 'Awaiting ordinary automatic trigger at approved head; observation %s/20\n' "$attempt"
  if [ "$attempt" -lt 20 ]; then sleep 30; fi
done
if [ -z "$run" ]; then
  printf 'No automatic exact-head run observed within bounded discovery; no dispatch attempted\n'
  exit 93
fi

capture 60-newhead-run-initial-original.json gh api "repos/$repo/actions/runs/$run" || exit 94
capture 60-newhead-merge-ref-initial-original.json gh api "repos/$repo/git/ref/pull/3778/merge" || exit 95
node <<'NODE' || exit 96
const fs = require('node:fs');
const assert = require('node:assert/strict');
const run = JSON.parse(fs.readFileSync('node_modules/.cache/native-handoff-ingress/60-newhead-run-initial-original.json'));
assert.equal(run.head_sha, 'e83d9f27f0e6a85f3a2791b1eadb85995c6ae701');
assert.equal(run.event, 'pull_request');
assert.equal(run.run_attempt, 1);
assert(run.pull_requests.some(pr => pr.number === 3778));
console.log(JSON.stringify({watching:run.id, head:run.head_sha, attempt:run.run_attempt, status:run.status}));
NODE

gh run watch "$run" --repo "$repo" --interval 60 --exit-status > "$root/60-newhead-watch-original.log" 2>&1
watch_result=$?
printf '%s\n' "$watch_result" > "$root/60-newhead-watch-exit-original.txt"
printf 'Terminal new-head watcher exit: %s\n' "$watch_result"

capture 61-newhead-run-final-original.json gh api "repos/$repo/actions/runs/$run"
run_capture=$?
capture 61-newhead-jobs-final-original.json gh api --paginate --slurp "repos/$repo/actions/runs/$run/jobs?filter=latest&per_page=100"
jobs_capture=$?
capture 61-newhead-pr-final-original.json gh pr view 3778 --repo "$repo" --json number,url,state,headRefOid,baseRefOid,mergeable,mergeStateStatus,statusCheckRollup,reviewDecision
pr_capture=$?
capture 61-newhead-logs-original.log gh run view "$run" --repo "$repo" --log
logs_capture=$?
capture 61-newhead-artifacts-original.json gh api --paginate --slurp "repos/$repo/actions/runs/$run/artifacts?per_page=100"
artifacts_capture=$?
capture 61-newhead-junit-download-original.txt gh run download "$run" --repo "$repo" --pattern 'test-results-*' --dir "$root/61-newhead-junit-original"
junit_capture=$?
capture 61-newhead-refs-final-original.txt git ls-remote origin refs/heads/main refs/heads/lane-3613-p2-routes/handoff-next-path
refs_capture=$?
if [ "$run_capture" -ne 0 ] || [ "$jobs_capture" -ne 0 ] || [ "$pr_capture" -ne 0 ] || [ "$logs_capture" -ne 0 ] || [ "$artifacts_capture" -ne 0 ] || [ "$junit_capture" -ne 0 ] || [ "$refs_capture" -ne 0 ]; then
  printf 'Capture failure: run=%s jobs=%s pr=%s logs=%s artifacts=%s junit=%s refs=%s; originals retained\n' "$run_capture" "$jobs_capture" "$pr_capture" "$logs_capture" "$artifacts_capture" "$junit_capture" "$refs_capture"
  exit 97
fi

node <<'NODE'
const fs = require('node:fs');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const p = 'node_modules/.cache/native-handoff-ingress/';
const read = name => JSON.parse(fs.readFileSync(p + name));
const run = read('61-newhead-run-final-original.json');
const pr = read('61-newhead-pr-final-original.json');
const jobs = read('61-newhead-jobs-final-original.json').flatMap(page => page.jobs);
const log = fs.readFileSync(p + '61-newhead-logs-original.log', 'utf8');
const lines = log.split('\n');
const checkout = [];
for (let index = 0; index < lines.length - 1; index++) {
  if (/git(?:\.exe)?"? log -1 --format=%H/.test(lines[index])) {
    const hash = lines[index + 1].match(/\b[0-9a-f]{40}\b/);
    assert(hash, 'Actual checkout result absent after checkout command');
    checkout.push({job:lines[index].split('\t')[0], sha:hash[0], commandLine:index + 1, resultLine:index + 2});
  }
}
assert.equal(run.head_sha, 'e83d9f27f0e6a85f3a2791b1eadb85995c6ae701');
assert.equal(run.event, 'pull_request');
assert.equal(run.run_attempt, 1);
assert.equal(run.status, 'completed');
assert.equal(pr.headRefOid, run.head_sha);
assert(jobs.every(job => job.status === 'completed'));
assert(checkout.length > 0, 'No actual checkout witness in retained logs');
const counts = jobs.reduce((out, job) => {
  out[job.conclusion] = (out[job.conclusion] || 0) + 1;
  return out;
}, {});
const packet = {
  at:new Date().toISOString(), run:run.id, url:run.html_url, head:run.head_sha,
  status:run.status, conclusion:run.conclusion, attempt:run.run_attempt, event:run.event,
  startedAt:run.run_started_at, updatedAt:run.updated_at,
  pr:{number:pr.number,head:pr.headRefOid,base:pr.baseRefOid,state:pr.state,mergeable:pr.mergeable,mergeStateStatus:pr.mergeStateStatus,reviewDecision:pr.reviewDecision},
  counts, jobs:jobs.map(job => ({id:job.id,name:job.name,status:job.status,conclusion:job.conclusion,url:job.html_url})),
  checkout, originalLog:{bytes:Buffer.byteLength(log),sha256:crypto.createHash('sha256').update(log).digest('hex')},
  watcherExit:Number(fs.readFileSync(p + '60-newhead-watch-exit-original.txt', 'utf8')),
  previousFailedRun:45046385831, previousFailedProof:'13703fdf4270684c83c1c24e144f6ed3c73d6e4c',
  originalFixtureTypes:'47/49 BOTH FAIL166; independently accepted scoped nonregression only',
};
fs.writeFileSync(p + '61-newhead-terminal-packet.json', JSON.stringify(packet, null, 2) + '\n');
console.log(JSON.stringify({run:packet.run,head:packet.head,conclusion:packet.conclusion,counts,actualCheckouts:checkout.length,checkoutShas:[...new Set(checkout.map(row=>row.sha))]}));
NODE
packet_result=$?
gzip -c "$root/61-newhead-logs-original.log" > "$root/61-newhead-logs-original.log.gz"
gzip_result=$?
if [ "$packet_result" -ne 0 ] || [ "$gzip_result" -ne 0 ]; then
  printf 'Packet/gzip failure: %s/%s; originals retained\n' "$packet_result" "$gzip_result"
  exit 98
fi
exit "$watch_result"
