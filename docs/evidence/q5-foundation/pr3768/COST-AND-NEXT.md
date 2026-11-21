# Observed CI cost and remaining Q5 dependencies

Run44926471482 attempt1 (ordinary PR validation, no rerun) started2026-11-21
16:47:19Z and API updated-at completion17:09:27Z:22m08s. There are37job
records:33success/4skip. Successful job intervals sum8996s (149m56s),
with peak23overlapping intervals. These are observed wall intervals including
setup/post steps, not billed minutes, CPU usage, core count or a savings estimate.
The run executes4unit/component shards (Windows2+Ubuntu2),20E2E jobs
(main6,chat6,Annex4,classic2,stable2),2builds,2SDK chunks,
schema/lint/type/API/actionlint plus planning.

Longest job is Windows unit shard2:21m51s (16:47:35Z–17:09:26Z);
Windows shard1:10m05s; Ubuntu unit shards9m21s/6m39s. The Q5 pages
suite itself reports33.4273261s on Windows shard2; its50Q5 cases across both
files are48pass/2explicit platform skips. Job duration includes thousands of
other tests and setup, so no fraction of full-run cost is attributed to Q5.

Exact local0e6 two-file Vitest maxWorkers2 receipt is17.843094s child
wall (Vitest reported17.64s),49pass/1nativeWindows-only skip. Exact-root
ES2020 compiler child wall8.284658s; four-file lint0.327723s, all exit0.
Combined child intervals26.455475s. Admission waits, local dependency
preparation and review are excluded. This scoped Darwin run is not equivalent
to cross-platform full CI. Raw receipts/commands/hashes remain separately
preserved. No Go CI baseline was measured here; ci-cost.json supplies the
observed comparable units for Meeko/Go coordination without speculative savings.

## Actual gates versus unfinished implementation

- Scoped draft3768: independent G2/G4 hosted-evidence assessment is a real
  pending review gate. Native no-override reuse ran/pass/not-skipped with an
  actual checkout/five-source bridge; final main/composition guards will still
  apply at any future authorized landing. No merge authorization is inferred.
- Runtime integration has a concrete coordination gate: bind an accepted actual
  shared lifecycle coordinator module/type and hunk ownership. The historical
  RuntimeSessionGeneration proposal alone is not that binding. Q5 must not
  create a duplicate coordinator; recovery/lateACK cannot affect a replacement
  chat/member or turn UNKNOWN into unsubmitted. No new binding is claimed.
- Root-backed state and catalog are ordinary unfinished approved work, not an
  auth/access/product-choice block: one physical backend/commit queue, strict
  root codec, incremental six-root updates, authoritative barrier provenance,
  nonce/generation catalog, post-ID profile and large-baseline R1 activation
  record/cut proof. Current prepared roots/indexes confer no authority.
- Local-human retry/adoption IPC/UI, sender/frame/nonce checks, migration and
  revocation/wake/provider-entry fences remain unimplemented and must be reviewed.
  Phone/Annex has no retry/adoption authority from this contract.
- Whole hot-state/transient heap, orphan GC, mixed-version rollback controls
  and native platform/FS limits remain proof work. Cache-only bounds do not
  close the memory contract; FAT/network/ino0/native attributes/sharing and
  powerloss are not covered by the observed Windows regular-file success.

Existing gh publication/read route now works; no new auth/grant is needed for
this scoped PR. Parent reply route succeeded on this turn. The earlier asleep
parent refusal and connector403 stay historical facts, not current blockers.

## Evidence packaging correction

Historical d0c9e2a4 committed the manifest, raw Q5 XML and derived summary but
Git's *.log ignore omitted four listed log excerpts. This successor adds only
those exact preserved checkout/OS/image/Node bytes with explicit force-add.
Every manifest entry is verified from staged then committed Git blobs, not only
from workspace files. Original d0c9 remains unchanged; source0e6/CI are unchanged.

## Queue and publication timing, kept separate

The gh jobs API reports created_at→started_at delays for33successful jobs:
55seconds total across jobs, range1–3seconds each. This excludes
dependency wait before GitHub creates downstream job records; it is not an
end-to-end queue estimate. The first planning job waited2seconds. Run
run_started_at equals created_at, so the run-level timestamp reports0seconds
between those two fields; it does not negate individual job waits.

PRcreated16:47:15Z→run updated/completed17:09:27Z is22m12s. The
actual source-push timestamp was not retained, so source-push→result walltime
is UNKNOWN. Commit author/committer time is not substituted for push time.
Run-created→updated22m08s and summed job execution149m56s remain separate.
The raw per-job timing API selection is job-timing-readback.ndjson.

For CI coordination the suggested method is changed paths plus dependants,
widen for shared/unknown impact, batch genuinely dependent tiny slices into
one immutable candidate and run broad integration once. This is a proposal
for comparison, not an implemented workflow change or measured savings. The
Windows G2/G4 requirement remains. No Go pipeline measurements were taken here.
