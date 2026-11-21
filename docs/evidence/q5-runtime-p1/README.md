# Q5 runtime P1: unverified, unwired work in progress

**NOT ACCEPTED.** Normal admission subsequently executed the frozen `c616`
candidate: 39 targeted tests and scoped lint passed, but production TypeScript
failed. This successor contextually types the ten frozen brand constructors;
its execution proof is still pending. The original refusal and compiler failure
are preserved, not converted into passes. No PR, runtime binding, phone
acceptance or journal acceptance is claimed.

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

Branch: `lane-3613-p2-routes/q5-runtime-p1`. The following SHA256 values identify
the exact candidate source in this evidence commit; they are not execution proof.

| File | SHA256 |
| --- | --- |
| `src/shared/chat/runtime.ts` | `3d30b01c5a256a3f7d7b2735e1506ea18922c8c2bb0e55ab60a446aa4104bb32` |
| `src/main/services/agent-runtime/runtime-coordinator.ts` | `695423ea0ba6ecb91961b9420b0c64f316e3e26229271b0a12afd3e1360ee9c0` |
| `src/main/services/agent-runtime/runtime-coordinator.test.ts` | `d58f04aaea8beb6acc9ce7bccd155dcb260b32407cf2f626b7222d8d9eec8c09` |

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
Successor tests, production/fixture types, lint, mutants and exact-source
re-review remain pending. Earlier `c616` passes are not successor proof.

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
