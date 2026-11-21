# Hosted observations for G2/G4, independent assessment pending

PR3768 remains DRAFT/open at exact head0e6c898ada85efefb80bc3aec61e07d3d15d2b19.
Normal Validate run44926471482 attempt1 completed **success**, without manual
dispatch/rerun, source change, cancellation, rebase or credential/access change.
Original connector403 is preserved separately; publication used the user's
explicit gh-only existing-auth route. All GitHub observations here used gh.

## Actual checkout and five source hashes

Windows unit shard2 job136913610220's raw checkout excerpt shows fetching and
checking out refs/remotes/pull/3768/merge, then git log -1 returning
`a2b621bbd6790059d22abaae2ef519b747bb202e`. This is the actual job checkout,
not inferred only from the PR API's merge ref. It merges source0e6 into base
f19eceee25effd264276d70a419bebfe58924876. The preserved five-file Git-blob
SHA256 bridge matches all five files on that exact checkout to assembled0e6.

The raw job excerpts identify Windows Server2025 (10.0.26100), runner image
windows-2025-vs2026 version20261116.315.1, Node22.23.4/npm10.9.9. These are
canonical Git-blob hashes plus normal Actions checkout attribution, not an
atomic hosted working-tree before/after seal. Filesystem type was not recorded.

## G2 observed

Across both Windows shard reports, exactly one testcase named
`native Windows reuse sync succeeds without platform or descriptor overrides`
is present. It **passed**, with no failure/error/skipped element. It belongs
to pages.test.ts in Windows shard2. The immutable source invokes real default
platform/open/sync behavior with no test overrides in that case.

Shard1 contains no Q5 suite; its general green job was not counted as native
index proof. Shard2 has pages39 cases:37passed/2skipped, failures0/errors0;
durability11 cases:11passed/0skipped, failures0/errors0. Total Q5:48passed,
2explicit platform skips. This is not the local Darwin49pass/1skip count.

## G4 observed

All relevant process-exit, symlink, prefix-directory rename, identity change,
own-temp cleanup and actual rename-refusal cases **passed**. This includes the
unflushed-process/reopen/reuse discriminator and skip-dirty mutation assertions,
actual temp-opened exit/residue, symlink swap to original inode, followed final
symlink with O_NOFOLLOW cleared, and same-content replacement before open/sync.

Only two cases skipped, exactly as their explicit win32 platform predicates:

- native POSIX read-only reuse and actual sync;
- Unix regular-file-to-FIFO swap.

No symlink-creation EPERM/ENOTSUP/EACCES skips occurred in this run. Such skips
would remain withheld coverage, not passes. Synthetic descriptor/directory
error controls remain controlled fault tests even when executing on Windows;
they are not real OS-injected disk/permission failures.

## Original artifacts and exact retained slices

| Windows shard | Actions artifact | Verified ZIP SHA256 |
| --- | --- | --- |
| 1 | 14716785413 | 9acd8a6237d95afdee2d96cb795b303ea823bc4b9bd5e2bcef308e940485bc35 |
| 2 | 14716349143 | 7d06f09b788c7d55beb39baab2c9c24f5cc70edcd23b8463e952dd72bb0af87c |

Both ZIP digests match the Actions API. Full ZIP/XML/job-log originals are
privately preserved under ~/.clubhouse/orch/evidence/q5-implementation/pr3768;
canonical artifacts expire2027-02-19. This remote bundle retains exact Q5 XML
suite byte slices and exact checkout/OS/image/Node log slices, with offsets,
original full XML/log hashes and derived status data in hosted-summary.json.
Unrelated complete JUnit/log content was not copied into the repository.
collect-hosted.py is preserved and hashed; a separate bundle manifest binds
all retained files. Reviewer can independently download the named artifacts
through gh and reproduce each slice/hash/status before their expiry.

JUnit has no captured child stdout here: passing process-control assertions
establish their expected exits, not separately emitted raw child diagnostics.
The native testcase does not emit directoryDurability: no stronger directory
sync mode is inferred from its success. Existing file-sync-only observations
remain weaker. No power-loss, whole heap, FAT/network/ino=0, native read-only
attributes/deny-write-sharing, production caller/catalog/activation/R1/migration/
runtime/UI or whole-Q5 acceptance follows. Permission/sharing errors must still
refuse. Keep draft pending independent hosted-evidence assessment and any final
current-main guards; no merge/release authority is created by this evidence.
