# PR3777: sole automatic hosted result

**Validate45031884736, attempt1: SUCCESS. 33 jobs succeeded and4 skipped.
Both Linux and Windows JUnit archives contain all100 selected synchronization
cases PASS,0FAIL,0SKIP.** This documentation receipt does not change PR3777's
head or trigger a new PR run. No merge, release, manual dispatch or rerun.

## Exact source and actual checkout

| Object | Observed identity |
|---|---|
| PR | [3777](https://github.com/Agent-Clubhouse/Clubhouse/pull/3777), ordinary OPEN/non-draft |
| Sole automatic run | [45031884736](https://github.com/Agent-Clubhouse/Clubhouse/actions/runs/45031884736), `pull_request`, attempt1 |
| PR/source proof head | `868d8b53fdb20c23876c83538c855165761b40df` |
| Executable/doc/test source | `9a5247cadf41756bc1c085a87c59493b34d5e99f` |
| Actual checkout from original hosted logs | `2724f81e7b3fdd00b1083b0b331fa12f85e07be9` |
| Actual checkout parents, in order | `c2a59f9f2c872bf2cb1fe9852adf8c92f2a996fc`, `868d8b53fdb20c23876c83538c855165761b40df` |
| Actual checkout tree | `208fb893fcc36e7154efdb2df07206f85d65f6ed`, exactly the PR/source-proof tree |
| Run start / terminal update | `2026-11-22T14:16:02Z` / `2026-11-22T14:38:18Z` |
| Watcher | One attached owner,60-second interval; original watch exit0 |

The owner extracted actual `git log -1 --format=%H` observations from the
original run-log ZIP, then read the immutable checkout commit through gh.
Its actual parents/tree match, rather than substituting a later PR merge ref.
The PR head contains no executable/doc/test/config change after tested9a;
only its frozen local proof was added. This hosted receipt is a separate
docs-only evidence branch and was not executed by this run.

Fresh terminal observations show actual main/basec2a, unchanged pushed868,
clean source worktree, ancestry, OPEN/non-draft/CLEAN/MERGEABLE and all37
completed check results. They are time-bounded observations, not a permanent
landing authorization or substitute for fresh guards at merge.

## Actual selected JUnit cases

| Complete fixture | Linux PASS | Windows PASS |
|---|---:|---:|
| `handoff-host.test.ts` | 33 | 33 |
| `handoff-coordinator.test.ts` | 19 | 19 |
| `handoff-service.test.ts` | 23 | 23 |
| `handoff-command-store.test.ts` | 10 | 10 |
| `handoff-retention.test.ts` | 14 | 14 |
| `annex-reverse-handoff-sync.test.ts` | 1 | 1 |
| Selected total | **100** | **100** |

Each platform's first shard has commands/retention/service47 selected cases;
its second has host/coordinator/actual pinned assembly53. No selected failure
or skip. All four full original JUnit XML files are preserved; their overall
case counts are36,513 on Linux and36,511 on Windows. These totals include
unrelated cases and are not falsely described as all PASS or new handoff
acceptance. Actual case identities/counts are bound in `source-map.json` and
the original XML, not inferred from aggregate workflow success.

The37 workflow jobs contain33 SUCCESS and4 SKIPPED. Skipped are Dependency
resolution preflight, macOS unit, macOS build + E2E smoke and Linux Package
Smoke Test. Existing macOS pause and ordinary-plan selection remain skips,
not passes. Normal Linux/Windows build, unit, lint/typecheck and existing E2E
jobs succeeded. Existing E2E success does not itself add new full-duplex
product coverage.

## Preserved originals and bounded attribution

`manifest.json` binds20 artifacts with raw/stored bytes and SHA256: original
start/terminal run and jobs APIs, artifact inventory, watcher output/exit,
full original log ZIP, all four original JUnit XML files, checkout commit,
initial/terminal PR observations, actual main, initial sole-run observation,
and derived checkout/JUnit/terminal summaries. The ZIP is preserved directly;
other originals use gzip with separate raw identities. Raw tool output is
not trimmed or rewritten. Approximately49.6MB raw/5.88MB stored were measured
and retained without installing tools or running local product validation.

The actual hosted source follows the [full6f15 independent approval](https://github.com/Agent-Clubhouse/Clubhouse/blob/6f15b83d35a86b25dd24cfac4289de3bc9440909/docs/qa-transfer/2026-11-22/reports/handoff-reverse-sync-9a524-independent-source-review.md)
under6385/404f and the [exact868 local proof](https://github.com/Agent-Clubhouse/Clubhouse/blob/868d8b53fdb20c23876c83538c855165761b40df/docs/evidence/3613-handoff-reverse-sync/proof/README.md).
Those immutable source/proof/review refs and all original FAILs remain
unchanged. The prior Details54FAIL, Gitdiff FAIL1/FAIL139 dispositions and
unexplained original Windows timeout are not rerun, relabeled or explained
by this successful attempt. No timeout cause/fix or speed claim.

## Acceptance limits remain

The selected actual pinned assembly has real TLS/control, hosts/coordinators
and durable domain stores, with direct refused and no received snapshot.
Positive native grant callbacks, preparation binding, worker/provider and
application route dispatch adapter remain fixtures. Deadline cases use fake
timers with actual deadline helper and held mocked operations, not measured
five-second wall-time network drains. Receiver decline is retrieved by sender
retry, not proof of receiver-originated push.

Reuse unchanged a407/be01 lower source/receiver614,417-byte fsynced-cut/resume
proof only under74d's accepted boundaries. Old81,937-byte envelope credit and
raw-versus-trimmed hash definitions remain distinct. Neither local nor hosted
success proves native grants/Git preparation/content-through-coordinator,
apply/wake/UI/human consent/two-host/full-handoff/full-duplex acceptance.
No client/control/protocol/cap/grant/settings/shared-store/phone/protected-WIP
change is made by this receipt.
