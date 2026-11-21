# Q5 runtime P1: unverified, unwired work in progress

**NOT ACCEPTED.** Source and fake-hook controls are preserved; no test runner,
compiler or linter has executed. The original resource refusal is not a test
failure or a pass. No PR, runtime binding, phone acceptance or journal acceptance
is claimed.

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

## Preserved source identity

Branch: `lane-3613-p2-routes/q5-runtime-p1`. The following SHA256 values identify
the exact candidate source in this evidence commit; they are not execution proof.

| File | SHA256 |
| --- | --- |
| `src/shared/chat/runtime.ts` | `3d30b01c5a256a3f7d7b2735e1506ea18922c8c2bb0e55ab60a446aa4104bb32` |
| `src/main/services/agent-runtime/runtime-coordinator.ts` | `fa6d6562b6c0cf481482ec15ffbd4b30caa55a5daab10e1500e2aa9e47a8e07c` |
| `src/main/services/agent-runtime/runtime-coordinator.test.ts` | `ade0c4fd70cbb9e6a7f88e77efc82bb5152142c8ca0a29c03c9e85e8e5a55996` |

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
| Independent exact-source QA | Pending; design approval is not source approval |

Static corrections occurred after the refusal. The fingerprinted candidate has
no execution proof. No dependency failure occurred; no install, baseline reset,
guard edit, periodic retry, alternative runner, full suite or local E2E was used.
Wait for the independently reviewed gate repair to be applied and normal
admission to pass before retrying any gated command.

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
