# Q5 runtime P1: unwired source proof, independent review pending

**NOT ACCEPTED; independent exact-source re-review pending.** Exact source
`2766cc377e766540e4c2e46718a4bcc372ef3d76` passed 39 targeted tests, production
and fixture TypeScript, and zero-warning scoped lint through ordinary admission.
Five bounded mutants were killed; every mutation was removed and the restored
source passed all 39 tests again. Historical refusal and compiler failures remain
preserved, not converted into passes. No PR, runtime binding, phone acceptance
or journal acceptance is claimed.

This successor also preserves the prior static candidate
`c61665ca1d6ccf3285efbac80cac96e0e20c1e8e`, tree
`e42bfa8fa9ca529210ffbd556a71192e7b8370c0`, and the original
`9c85103c3a6e50e55d272b3e147ca8106ff5b9bc`, tree
`e8d62626833afc91eff2927f32661735c9f50453`. Its independent static review was
**NOT APPROVED**, with zero execution credit. The original commit and its
fingerprints remain available unchanged in history.

## Exact inputs

- Fresh `main` base: `5bbabde2d9f6dcb4db248d0976681fc331f5611e`,
  tree `7b1a379cabf025b78a517d6232e49fedbd682def`.
- Frozen contract: `8a0eb833e81956e3a0e2674fc276e028587d8c64`,
  tree `aa984103b154f67c31d8e2ce25e3c315459cad23`,
  `docs/design/q5-runtime-coordinator-binding.md`,
  SHA256 `8c14df58a7ba2dc08db1fff3a6f074073ee00b3cea98b3901fd4d68e65f507d6`.
  Its parent `4388d20855664230441648c5923351e32af92df0` is preserved.
- Independent design QA: `002bc36d9bdb274fec1a118f96539ee4e901b66b`,
  `docs/qa-transfer/2026-11-20/reports/q5-runtime-coordinator-8a0eb833e-review.md`,
  SHA256 `93caa14141cd9ad19bd0d66cbf71ece696146a30717e7239aac2027feed0e15b`.
  The complete 60-line report was read. It approves design/P1 readiness under
  D1-D3, not this implementation.
- Q5 D1/D2 concurrence: `b05c927a16e49d243fcdec8fe72e19d8f3125669`,
  tree `789671de3a76f7a0f0c36e1afccf9ff2ab73712d`,
  `docs/evidence/q5-foundation/runtime-8a0-ledger-concurrence.md`,
  SHA256 `b2273bf5b721eecc28c5a3c4af6ccd0b5b20c3c263249284ad34cf9cab90d25d`.
  This is typed interface concurrence, not an executable journal dependency.
- Independent source findings: `f337627da625d8e099cc613561890be69e34283c`,
  tree `1f4ac0e8e61b4a55820e3ffe65b66067be2cbbea`,
  `docs/qa-transfer/2026-11-20/reports/q5-runtime-p1-9c85103c3-static-review.md`,
  SHA256 `1a5d9a76fa497ef9204d504b0848f3ae1ebabfbf8280bb2905b4797a57e7041f`.
  The complete 93-line report was read; it does not approve this successor.
- Static successor review: `fe1d4dc7d745abc525267eb6e5e40baae769f084`,
  tree `32411940c0dfcf11da869d36b43a50e3b87e707c`,
  `docs/qa-transfer/2026-11-20/reports/q5-runtime-p1-c61665ca1-static-review.md`,
  SHA256 `4f5b35b22e2cc8a911354451c4e1465f509fcecd1a79127ae9ef06a5b3a5d0db`.
  P1-a through P1-e and WeakRef lifetime were accepted statically, with no
  execution or PR approval.

## Preserved source identity

Branch: `lane-3613-p2-routes/q5-runtime-p1`. The exact tested source is
`2766cc377e766540e4c2e46718a4bcc372ef3d76`, tree
`e263078f60e3ab6bf107264fc915f09e6321d8cc`, parent
`a5781b18461e8450f88d3997fe506018a5f779a6`. The following SHA256 values identify
that source and its byte-identical copy in this evidence-only successor.
Fingerprints alone are not execution proof; the original receipts below bind
the actual runs to `2766`. No command is claimed to have run on the later
evidence commit ID, and no source-changing successor may inherit these results.

| File | SHA256 |
| --- | --- |
| `src/shared/chat/runtime.ts` | `3d30b01c5a256a3f7d7b2735e1506ea18922c8c2bb0e55ab60a446aa4104bb32` |
| `src/main/services/agent-runtime/runtime-coordinator.ts` | `695423ea0ba6ecb91961b9420b0c64f316e3e26229271b0a12afd3e1360ee9c0` |
| `src/main/services/agent-runtime/runtime-coordinator.test.ts` | `b74712c6a5373dc24ff913588ce714fd09bacda084b09d10f60d3bf17300de55` |

P1 adds unused main-issued brands/types and one unwired singleton with private
registries, original generation/start/resource identity, queue/publication
binding, scoped revocation and finite holds. Loss uses exactly the proposed
`entered | journal_owned` marker and `RuntimeLossClaim` hooks.

Unexpected marker exceptions record UNKNOWN and invoke one `onLoss('unknown')`.
Synchronous loss-hook failures retain a rejected settlement promise and the
retirement latch. Candidate classification is informational, not committed proof.
Journal-owned claims schedule nothing. An unrequested/in-progress loss lookup
throws rather than pretending a journal-owned outcome.

Scope revocation closes all original-scope tickets before loss callbacks, leaves
unrelated scopes intact and requires fresh verified authority for new admission.
An old token cannot revoke a refreshed scope. Historical observation has a
separate original-correlation closure; no approved ACK mapper is available.

## Corrected interface bridge for P1-a through P1-e

The preserved `8a0` contract names the scope-wide operation `closeAdmission`.
The corrected port instead exposes exactly
`revokeScope(admission: RuntimeAdmissionLease): void`, with the same scope-wide
revocation semantics. There is **no** `closeAdmission` alias. Ordinary per-attempt
retirement uses `retireHandoff`, never scope revocation; its local disposition
does not imply successful delivery. A focused control retires one attempt while
another attempt and new admission in the same scope remain eligible.

**Live-only entry:** dormant handoffs cannot enter until their original resource
is attached and their generation is live. P1 does not support entry before
mission-bearing native argv/spawn. Any such selected launch path needs a
separately reviewed extension before use; there is no earliest-argv coverage
claim. The currently permitted post-creation chat send and post-spawn PTY pending
command still need their later actual-ingress adapters and proof.

The exported test reset now refuses unless `VITEST` is exactly `true` and
`NODE_ENV` is not `production`, before touching issuance state or timers.
Controls exercise both production and absent-runner refusal with the original
lease, registry membership, ticket liveness and pending timer unchanged.

`allowed()` now additionally checks the original record is present, not retired
and still live at its current generation/admission. It remains synchronous,
memory-only and ledger-free. The separate predicate factory retains only scalar
ticket state and a native **weak** original-record reference, not strong owner,
driver or journal hooks. The native constructor is feature-detected with a local
type declaration, preserving the ES2020 target/lib and adding no dependency.
Unavailable support explicitly refuses ticket construction; an unavailable
weak target fails closed. No strong-reference fallback is permitted.

`captureAdmission` and `createHandoff` keep the `8a0` lease/handoff return
signatures. Expected closed/held/stale admission failures now throw the exported,
typed `RuntimePreIntentRefusal`, with reason `scope_closed`, `scope_held`,
`lease_not_current` or `admission_not_current`. Unregistered/fabricated values
remain protocol errors. These refusals construct no handoff, invoke no attempt
hook and do not create an intent, report loss or schedule a retry.

P5 must handle this class during its approved admission preflight, before
issuing new intent/capability. **The name never proves an existing durable
attempt was pre-intent or never entered.** If an adapter already has an intent,
it must conservatively reconcile that original attempt under the separately
reviewed Q5 binding; it may not erase it, recapture a replacement or resend.
Real constructor/intent ordering is still unimplemented and unaccepted.
The `markEntered` and `RuntimeLossClaim` signatures concurred at `b05` are
unchanged; this bridge needs independent successor review before adoption.

## Original admission refusal

The first attempted command, from the isolated P1 worktree:

```sh
~/.clubhouse/orch/desktop-test-gate.sh lane-p2 4 -- npm test -- --project main src/main/services/agent-runtime/runtime-coordinator.test.ts --maxWorkers=2
```

Exit: **75**, before the runner started. Verbatim output is preserved in
`gate-vitest-attempt-01-original.txt`; SHA256:
`5e9446b0ae4e9acf046b10ea31bea07bc1b6b5890535699d20ece15693cc7118`.
It is byte-identical to the original ignored log. `.txt` is used because the
repository ignores `*.log`.

| Check | Observed result |
| --- | --- |
| Targeted Vitest | Gate REFUSED: `swap_grew=1812->3929M`; **0 executed tests** |
| Production TypeScript | NOTRUN; no admission attempted after the refusal |
| Test-fixture TypeScript | NOTRUN; production `tsconfig.json` excludes tests |
| Scoped ESLint | NOTRUN; no admission attempted after the refusal |
| Unchecked-brand mutant / negative execution | NOTRUN |
| Independent exact-source QA | `9c` NOT APPROVED at `f337`; successor re-review pending |

Static corrections occurred after the refusal. At that blocked stage the
candidate had no execution proof. The P1-a through P1-e corrections also occurred
afterward. No dependency failure had occurred, and no install, baseline reset,
guard edit, periodic retry, alternative runner, full suite or local E2E was used.
No attempt occurred until the reviewed gate was installed and its owner-reported
normal root run released the slot.

## First normal proof and compiler-fix attribution

The installed gate SHA256 was verified as
`d45cbfb0449abc1ce34bbc84960292dca70e6b551944beb9109b79d11fe9a7d3`
before the first normal P1 run. Source/HEAD seals matched exact `c61665ca1`.
The original swap refusal remains in history; it gives no execution credit.

| Exact `c616` command, ordinary gate | Observed outcome |
| --- | --- |
| min 4: targeted Vitest command above | 39 tests, 1 file PASS; END `19:23:22Z`, rc 0 |
| min 4: `npm run typecheck` | FAIL 11 diagnostics; END `19:23:48Z`, rc 2 |
| min 4: `npm exec -- eslint src/shared/chat/runtime.ts src/main/services/agent-runtime/runtime-coordinator.ts src/main/services/agent-runtime/runtime-coordinator.test.ts --max-warnings=0` | PASS, zero errors/warnings; END `19:24:05Z`, rc 0 |

`tsc-attempt-01-original.txt` preserves the byte-identical failure, SHA256
`dfa286bf5f57d8ba8a74054d8bc556dd8121166621ca482485f3a70de3f75cf7`.
Ten TS2322 diagnostics were literal brand widening through `Object.freeze`;
the successor supplies the exact interface as the generic contextual type,
without a cast, weaker brand or runtime change. One TS2307 was the absent
worktree-local Azure exporter configuration. Only after that observed dependency
failure, ordinary min-6 `npm ci` restored dependencies (1,275 packages; END
`19:24:56Z`, rc 0). Dependency manifests and script approvals were unchanged.

The module-local WeakRef declaration produced no observed TypeScript or lint
diagnostic, so it was not changed and no lint/lib rule was relaxed.
`fixture-tsconfig.json` minimally extends the repository config to include this
test file; production TypeScript excludes tests. Its distinct gated check is
`npm exec -- tsc --noEmit --project docs/evidence/q5-runtime-p1/fixture-tsconfig.json`.
At this historical stage successor proof remained pending. Earlier `c616`
passes were not transferred to the successor; its own proof is recorded below.

The brand-typing successor `a5781b18461e8450f88d3997fe506018a5f779a6`
then passed normally gated production TypeScript (END `19:29:46Z`, rc 0).
Its separate fixture check failed TS7010 on the fake WeakRef `deref` method's
inferred `any` return (END `19:29:54Z`, rc 2).
`fixture-tsc-attempt-01-original.txt` preserves that byte-identical failure,
SHA256 `0016e92960427dcac8aa87a5c7ab918e7099cdbe191bbb91433e9d83819f6787`.
The one-line `: undefined` fixture annotation preserves behavior and satisfies
the inherited `noImplicitAny`; no compiler option is relaxed. Its source head
`2766` received its own complete proof below, not inherited passes.

## Exact `2766` ordinary-admission proof

All commands ran from the isolated P1 worktree on 2026-11-21, after checking its
HEAD and source seals. The ordinary gate prefix for each command was
`~/.clubhouse/orch/desktop-test-gate.sh lane-p2 4 --`. No full suite, packaging,
local E2E, guard edit, reservation, refusal loop or admission bypass was used.

```sh
~/.clubhouse/orch/desktop-test-gate.sh lane-p2 4 -- npm exec -- tsc --noEmit --project docs/evidence/q5-runtime-p1/fixture-tsconfig.json
~/.clubhouse/orch/desktop-test-gate.sh lane-p2 4 -- npm run typecheck
~/.clubhouse/orch/desktop-test-gate.sh lane-p2 4 -- npm test -- --project main src/main/services/agent-runtime/runtime-coordinator.test.ts --maxWorkers=2
~/.clubhouse/orch/desktop-test-gate.sh lane-p2 4 -- npm exec -- eslint src/shared/chat/runtime.ts src/main/services/agent-runtime/runtime-coordinator.ts src/main/services/agent-runtime/runtime-coordinator.test.ts --max-warnings=0
```

| Actual check | Outcome | UTC END | Original receipt |
| --- | --- | --- | --- |
| Fixture TypeScript | PASS, zero diagnostics, rc 0 | `19:31:08Z` | `fixture-tsc-final-original.txt` |
| Production TypeScript | PASS, zero diagnostics, rc 0 | `19:31:33Z` | `tsc-final-original.txt` |
| Targeted Vitest | 39 PASS, 1 file, rc 0 | `19:31:36Z` | `vitest-final-original.txt` |
| Scoped ESLint | PASS, 0 errors / 0 warnings, rc 0 | `19:31:37Z` | `eslint-final-original.txt` |
| Post-mutation restored Vitest | 39 PASS, 1 file, rc 0 | `19:36:35Z` | `vitest-restored-original.txt` |

The ten `Object.freeze<ExactInterface>` contextual annotations are exclusively
the compiler correction introduced at `a578`; the fixture return annotation is
exclusively the subsequent `2766` correction. The complete current matrix ran
after both changes. Root `tsconfig.json` SHA256 remains
`bed57c7a173516b4595951e8af318fc76e40c2e02f64836f0ae0db8249272432`;
the inherited fixture config SHA256 is
`3b833584d6df0cd9dc24d5365853d5924b6df4d03f20a404f5e5c01e42922e88`.
No target, lib, lint rule, brand or public signature was relaxed.

## Bounded mutation controls and restoration

Every mutant was uncommitted, started from exact `2766`, and used the same
ordinary min-4 gate and at most two workers. Each expected rc 1 is a killed
mutant, not a baseline defect. SHA256 is of the temporarily mutated coordinator.

| Mutant | Observed result | Mutated source SHA256 |
| --- | --- | --- |
| Replace both private issuance registries with symbol-brand membership | 3 FAIL / 36 PASS; rc 1, END `19:33:22Z` | `cc21f00f92a7e21c9cd76d64deadc2f0d5c487ac204cdec155bd5e375f5a7862` |
| Remove the retirement guard and retain the loss callback | 2 FAIL / 37 SKIPPED; rc 1, END `19:34:06Z` | `f30a9ed996739c5f0374e9938b02015caf6b766fa74a89b3b2e3ceb1aac8d2ec` |
| Convert unexpected marker exceptions into rejected entry, skipping UNKNOWN loss | 2 FAIL / 37 PASS; rc 1, END `19:34:43Z` | `9b37ccbebc7224cd1551af1241d3dcc0fc0c7c1f3ae62b09cada75969ae51760` |
| Reopen scope authority automatically on hold expiry | 2 FAIL / 37 PASS; rc 1, END `19:35:07Z` | `8b17ea478670a570d7bd74c59422f0c76ec6188774b7976cf6a3531724f9f019` |
| Forward a fabricated approved-ACK discriminator | 1 FAIL / 38 PASS; rc 1, END `19:35:39Z` | `11b11dd9be1c6b37f11f1fd00b961e6e0c065612f8bf34a66c27910f97b2dc0d` |

The unchecked-brand controls reject fabricated/cloned handoffs, cloned transport
tickets and tokens from the old private registry after reset. The repeated-loss
mutation selected only the two non-reentrant retained-promise/latch controls,
avoiding unbounded recursion:

```sh
~/.clubhouse/orch/desktop-test-gate.sh lane-p2 4 -- npm test -- --project main src/main/services/agent-runtime/runtime-coordinator.test.ts --maxWorkers=2 --testNamePattern 'retains one actual committed promise|retains a failed promise and the latch'
```

The other four mutants used the complete targeted 39-case command above.
Marker controls cover both claimed and journal-owned loss decisions; expiry
controls reject automatic fresh admission; the ACK control rejects before the
fake receipt hook. These are fake-only controls, not real journal or SDK proof.

After each run, surgical restoration reproduced coordinator SHA256
`695423ea0ba6ecb91961b9420b0c64f316e3e26229271b0a12afd3e1360ee9c0`
and a clean tracked coordinator diff before the next mutation. After the fifth,
HEAD remained `2766`, both tracked index/worktree diffs were clean, all three
source seals matched, and ordinary admitted Vitest passed 39/39. Its receipt
includes the three restoration seals. No mutant was committed or pushed.

## Dependency restoration provenance

The first ordinary `c616` typecheck actually diagnosed
`src/main/telemetry/destinations/azure.ts(29,38)` TS2307 for the direct relative
import of the absent task-local
`node_modules/@azure/monitor-opentelemetry-exporter/dist/commonjs/_configuration/configurationManager.js`.
Existing ancestor-workspace tooling had allowed the earlier test/lint commands;
that did not provide this directly referenced task-local file. Only after this
diagnosis was one ordinary installation admitted:

```sh
~/.clubhouse/orch/desktop-test-gate.sh lane-p2 6 -- npm ci
```

It ran in `node_modules/.cache/q5-runtime-p1-work`, START `19:24:25Z`, END
`19:24:56Z`, rc 0, and added 1,275 packages. The existing root postinstall
performed its two node-pty spawn-helper executable-bit fixes. No dependency
manifest, script approval, audit fix, compiler option or source behavior changed.
Installation restored validation prerequisites; it is not credited as a P1
product fix. Raw npm deprecation/audit/unapproved-script notices are preserved,
not treated as a performed security review.

The before identity is the frozen `c616` Git blob for each manifest at the
installation's source head. **No separate physical pre-install hash sidecar was
captured.** Current physical hashes were measured after installation and match
those frozen blobs; `git diff c616 -- package.json package-lock.json` is empty.

| Manifest | SHA256 of both frozen-before Git contents and measured-after physical contents |
| --- | --- |
| `package.json` | `02a5006fdd2b94506ec91db8db8e093bcafeaf0174ee08c0a563f459bc4ac7a9` |
| `package-lock.json` | `bd9cc80304b81d317f2ffb295d9af5abbc484bf8efb64fc8d7f118e1288c212d` |

The restored local exporter is `@azure/monitor-opentelemetry-exporter`
`1.0.0-beta.46`. Its package metadata SHA256 is
`3acaceab55ad1bec11582d3d345c7da20720551ae98eb6b5e759c524375f2fae`;
the previously missing configuration file now exists with SHA256
`56dcce68a691b276c492534c25de4a0bfed1b9d56c462b4ed9e55a29b334b6b2`.
These are installation provenance, not committed vendored dependencies.

## Portable original receipt fingerprints

The following copies are byte-for-byte generated tool output, including original
FAILs and unsuppressed configuration warnings. Together with the three earlier
preserved refusal/compiler receipts, they survive outside ignored `node_modules`.

| Receipt | SHA256 |
| --- | --- |
| `npm-ci-attempt-01-original.txt` | `ee0243c24e536684374addbf0c7f2235f37c7f7e0e7cc261a472c212015f2647` |
| `fixture-tsc-final-original.txt` | `dce943ffdc41a635d668198b291f6abd7be410dfdee027344646f61df9a93121` |
| `tsc-final-original.txt` | `f0c3e46c69a4a37d83aaf3d20b5019db6b00437d86f2db9abb2c09633dc0b92b` |
| `vitest-final-original.txt` | `0980f24c2f7951a98fc64c5fcc3139fd028d265a4a4e3e982aac4b238b371836` |
| `eslint-final-original.txt` | `4bf32f91cef872ec643c02e926814ebc8412efadb8ce5dd0cd1ae4f4a60f2c7b` |
| `vitest-restored-original.txt` | `48fddf5197ef21ff1892b1b8221dab49a3860fced3d5988fc2aafe59ebd80014` |
| `mutant-unchecked-brands-original.txt` | `69352fe6070ae025f15a78a28d7717c110838f4fae4af6c4e7d7f0bd3dca867c` |
| `mutant-repeated-loss-original.txt` | `7deb3001c404a774167e306a8fcbb77c4aef5f91a32da294199c2df12c7a28ad` |
| `mutant-marker-rejected-original.txt` | `3ba6339d8f11c8644404290175f48ed3a1c71ef827330d789d406de5142115f9` |
| `mutant-expiry-reopens-original.txt` | `f25e69e15226bd48c49f2c77a6a74d5fd8ff280cbc04d95a4b339ce759d81fa3` |
| `mutant-fabricated-ack-original.txt` | `cb639c93e62e5de3f6a2b73e86e0fb0a217d6ee4cf682f65d78f9eb4b53bc5ba` |

Independent exact-source re-review remains required before any PR. The earlier
static `fe1` report and typed Q5 `b05` concurrence are preserved prerequisites,
not approval of this execution evidence or of an executable journal binding.

## Deliberately deferred

No existing consumers, driver send signatures, IPC/preload/tools/plugins,
permissions, grants, public result/wire shapes, phone fixtures, native queues,
journal or schema are changed. Static reference search finds the new coordinator
and brands only in the new module/test and shared seam.

Actual chat/PTY ingress zero-call controls, delayed native sends, wake argv and
pending-command entry, lifecycle/removal/recovery, source-terminal historical
cleanup, real grant/store queues and the production hold budget/status sink
remain later reviewed pieces. Abandoned fake holds test deadline expiry, not
actual asynchronous membership throw/abort adapters.

Real Q5 marker/loss/history adapters remain unimplemented dependencies. The
dedicated ACK-first path also needs a synchronous competing-settlement fence.
ACK-first must decline a loss producer; loss-first must return the actual
committed outcome, with any genuine late ACK limited to original history.
No fake-hook control proves that arbitration, durable receipt strength, provider
processing, cancellation, SDK drain or exactly-once delivery.
