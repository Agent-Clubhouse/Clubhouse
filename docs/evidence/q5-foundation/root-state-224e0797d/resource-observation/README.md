# Read-only exact resource predicate observation

No test retry, child check, gate predicate/baseline/slot mutation or process
cancellation was performed. Current gate SHA256
61797476544935859d70911b17cab44fae4c2575180498ab6d9388a79f8fcf16.
Raw OS readings and exact source are retained with command/time/hashes.
Sanitized process classification contains no raw arguments or secrets.
Snapshots are consecutive read-only observations, not an atomic system seal.

## Code controls, not stale header comments

The script takes an atomic mkdir slot, then measures idle>=40%, available
free+inactive+speculative+purgeable pages using16KiB pages (actual host page
size matches), kernel free percentage>=25%, compressor<=12288MiB,
truncated swap used<=saved baseline+128MiB, plus optional explicit hold,
actual Swift compiler/linker for min>=6, and actual node Vitest/tsc matches.
Tests/lint request4GiB and compiler6GiB; two workers max remains. The top
comment's compressor8GB description does not match the12GiB executable test.
The separate unused-memory number is not the admission threshold.

SWAPBASE is read from /tmp/clubhouse-desktop-test.swapbase; if absent the
script would use current swap, but this file EXISTS. It is overwritten only
after all predicates pass, immediately BEFORE the admitted child runs. There
is no time window, expiry, decay or reset based on quiet/stable samples. Failed
admissions do not update it. The baseline1812MiB was written13:17:49Z,
last admitted q5-ledger scoped lint, which ended13:17:50Z. This does not prove
Q5 caused subsequent system swap growth. Q5's18:04:48/18:06:11 attempts were
refused before executing any child. Original local dependencies are restored.

## Current observation

Idle84.4% (script truncates84), available33209MiB (~32.4GiB),
kernel free87%, compressor1128MiB. Raw unused-memory and page-free
readings remain in top.txt/vm-stat.txt; available includes reclaimable pages.
Swap3945.44MiB truncates3945: exceeds1812+128=1940. Prior refused
readings also3945; stable now is NOT the same as within the saved baseline.
No slot/explicit hold or gate-relevant node/Swift/Xcode process was observed
in the sanitized process snapshot. No active Q5 tests/compilers and no observed
Go heavy job exist here. Parent reports Go has no known owned active heavy
job; other system-history pressure is unattributed, not assigned to Go.

The only failing measured predicate is swap against historical saved baseline.
A known Go build completion is NOT an available trigger. A concrete future
observation trigger is OS used swap falling to<=1940 truncated MiB, or truly
new normal authorized resource/policy evidence from owners. Passage of time,
current stable3945MiB or high available memory alone do not change this gate.
Do not reset baseline/rewrite thresholds/bypass/kill/restart/clean swap. Continue
source-only work and preserve224e unvalidated until actual admission changes.
