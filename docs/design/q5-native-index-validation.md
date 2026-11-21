# Q5 scoped native Windows index validation path

Planning only: no PR, CI dispatch/rerun, workflow edit, install, app activation
or release is performed by this document. Canonical work remains issue #3758.
Approved implementation73c16d41/evidence1686e85e is preserved; subsequent
test/docs work bridges to its unchanged production modules rather than
transferring all prior test counts.

## Existing delivery route, inspected source

Fetched main was `e8e178c4bf462bcf443bfb1b91cbfbcd1f35d1c2`. It has none of
the proposed private index paths. At that fetch, validate.yml, vitest.config.ts,
package.json/lock and classify-changes.mjs matched this worktree's versions.
Recheck the real main/base before assembling a candidate; this is not a stale
base permission to overwrite another owner's code.

`.github/workflows/validate.yml` already runs Unit + Component Tests on
windows-latest and ubuntu-latest, two shards, Node22.23.4. Normal code PR open/
synchronize/reopen events trigger the workflow. It runs npm test with JUnit
output test-results.xml and uploads test-results-<OS>-<shard>. Main-project
inclusion covers src/main/**/*.test.ts, so the native-Windows-only reuse case
will be selected by one Windows shard. A general green job is insufficient:
the artifact must show that exact testcase present, passed and not skipped.
The Windows build/E2E matrix uses windows-2022; do not call that the unit runner.
Electron is mocked for unit tests; this file path does not require an app start.

No new CI workflow or manual dispatch is needed. Existing workflow dependency
setup is its normal ephemeral CI process, not a new local install or dependency
change. Do not add full-ci labels or dispatch stable/release workflows for this.
Freeze the scoped reviewed head before PR; avoid superseding pushes while its
validation is running, because the existing PR concurrency policy cancels older
runs. Do not cancel jobs to obtain a new result.

## Proposed scoped review/PR assembly (not executed)

After complete dependency review, use a new isolated branch from freshly verified
main with only this private unimported subset, copied with exact source hashes:

- src/main/services/group-project-notice-ledger/pages.ts
- src/main/services/group-project-notice-ledger/pages.test.ts
- src/main/services/group-project-notice-ledger/durability.ts
- src/main/services/group-project-notice-ledger/durability.test.ts
- test/research/q5-index-process.cjs
- concise scope/limits documentation and links to preserved evidence

The page module depends only on private durability and Node built-ins. Its tests
depend on the page module/fixture, Vitest and existing TypeScript dependency.
Do not pull in sequenced state, journal, installation/adoption, sparse reader,
runtime, settings or UI merely to get a Windows receipt. No app import or
capability advertisement is added. Do not claim this isolated foundation PR
finishes/closes #3758. Suggested title: "Add isolated notice index and Windows
reuse validation"; resulting behavior is testable storage only, no delivery.

Record assembly base/head/tree and per-file SHA256 bridge, including exact test,
fixture, durability, lock, workflow and test setup sources. Run risk-targeted
checks on the assembled head under existing desktop admission, then independent
exact source/evidence review **before** opening that scoped PR. The current
whole task branch is not automatically that review-ready PR.

## Remaining dependency gate before that PR

Source73 has W1 source/policy approval;283 has POSIX read/reuse/temp/concurrent
flush approval. These do not cover the entire page primitive. Obtain bounded
assessment of build/put publication, root/index reference and version validation,
flush ownership/error behavior, cache eviction/memory accounting and the actual
fixture/test subset. Combined total heap remains unproved and must stay out of
the claim; catalog/activation/R1/global root durability and runtime are not part
of this PR's acceptance. Existing cache counts are not a whole-process budget.

The optional no-follow discriminator is test-only. It clears O_NOFOLLOW on the
real open, swaps the final pathname to a symlink pointing to the original file,
and requires actual content read followed by changed-while-reading refusal.
It uses directory movement to leave the file's inode/mtime/ctime intact; it
does not fabricate stat results or bypass the initial identity check. This is
no hostile parent-directory/CAS guarantee.

## Native result required and honest limits

Retain the actual run URL, job/attempt, runner OS/image/Node, checkout commit and
JUnit artifact. CI usually checks out a PR merge ref: bind its exact private
source/test/fixture/lock hashes to the independently reviewed head, assess any
base differences and preserve the bridge. Normal checkout/artifact attribution
is not retroactively an atomic embedded desktop source seal. A skipped, absent,
cancelled, failed-setup or unexamined testcase grants no Windows acceptance.

The no-override native Windows case must actually prepare, reopen, reuse and
sync the immutable file and flush its directory barriers, then read it. The
simulated win32 branch on Darwin does not execute FlushFileBuffers. Keep its
approved flag/refusal proof separate from the hosted native result.

O_NOFOLLOW may be absent on Windows: final lstat must detect a followed symlink;
do not silently treat it as a regular validated pathname. ino=0 FAT/network
identity behavior is unproven. Read-only attributes, deny-write sharing and
other access/sync failures must refuse, never be classified as durability
success. Native acceptance is limited to observed filesystem/identity conditions;
broader Windows attributes/sharing/filesystems need appropriate actual negative
controls before claiming their support. Directory file-sync-only observations
remain weaker than directory sync. No power-loss or provider delivery guarantee.

If a safe write-capable descriptor or required sync cannot be obtained, report
the actual refusal and retain original state. Do not fall back to read-only
FlushFileBuffers, truncate/recreate an existing page, downgrade permissions, or
request access to manufacture a pass. No merge/release/activation authority is
created by native validation.
