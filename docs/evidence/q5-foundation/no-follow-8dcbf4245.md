# Test-only followed-symlink discriminator and native validation plan

Exact successor `8dcbf42455123014b2bba4a03973afb786a153b5`, tree
`3cdf3fb0607d2e99099ac4e3ebe23d2a2eee2513`, pushed on
`auto-reset-policy-design/q5-durable-delivery-ledger`. Approved73/1686 and
review8577008ae7c1a82af64baee152db2e495f7e8fe9 remain preserved.

Only pages.test.ts and new docs/design/q5-native-index-validation.md differ
from73. The static bridge8dcbf4245-source-bridge.json verifies24/25 sealed sources
byte-identical, including all production modules. It records the intentional
test hash change and actual two-path diff. This is no transfer of older test,
compiler, native Windows or whole-branch acceptance to this head.

## Narrow actual result

The selected new test clears O_NOFOLLOW on the real descriptor open while
selecting the Windows branch. It moves the containing hash-prefix directory
aside (leaving the original file's inode/mtime/ctime intact), installs a final
symlink to that original file, and lets the checked descriptor follow it.
No stat results, initial identity checks or content checks are mocked/bypassed.

Assertions observe actual page content bytes read, exact original inode/device,
unchanged original bytes, zero sync calls and final changed-while-reading
refusal. This distinguishes final-path checking from a no-follow open failure.
It does not prove hostile parent-directory CAS, Windows FlushFileBuffers or
ino=0 FAT/network identity. The test executed on Darwin; native unsupported
symlink fixture creation may explicitly skip on Windows without extra access.

| Admitted check | Observed result |
| --- | --- |
| Vitest main pages.test.ts filtered to the new followed-final-symlink case, maxWorkers2 | exit0;1passed,32skipped;118ms total,13ms test |
| changed test file ESLint | exit0;0errors/0warnings |

Other32 cases were not rerun/credited. No compiler or broad suite ran on this
test/docs-only successor. Root test exclusions and prior73 results keep their
original scope. Vite advisory remains in raw output. Both commands admitted
sequentially min4 with no refusal/retry/cancellation. Equal clean head/tree and25
source hashes bind each receipt; new hashes match Git blobs. All54 receipt/raw
hashes verified, prior52 index rows unchanged. Matched local dependency linkage
is restored; original node_modules is back. Evidence head is packaging only.

## Concrete native route remains gated

The new design document inspects fetched main e8e178c4bf462bcf443bfb1b91cbfbcd1f35d1c2
and its unchanged CI/test/lock sources, whose hashes are in the static bridge.
It proposes an isolated current-main five-file private index/durability/test/
fixture PR after complete scoped dependency review, not the whole Q5 branch.
Normal existing Windows unit jobs and JUnit artifacts provide the delivery path;
no workflow modification, CI dispatch/rerun, PR or install has been performed.

The dependency gate explicitly includes unreviewed full build/put publication,
reference/version validation, flush ownership, cache eviction/accounting and
the exact fixture subset. Current partial approvals do not satisfy it. Before
Windows reliance, require the no-override native reuse testcase actually passed
on Windows, source/checkout identity bridge and inspected artifact, not a skipped
test or generic green job. Read-only attributes/deny-write sharing must refuse;
no permission downgrade or unsupported filesystem guarantee is introduced.
All catalog/root activation/R1/migration/runtime/UI/heap/release gates remain.
