# Independent #3774 phase-observation design review

**BLOCK — correct the final-output lifecycle before fixture implementation.** The native-only forwarding approach is defensible for the inspected callback-based Git seam, but the proposed `afterEach` annotation cannot work with the pinned runner lifecycle. This is a diagnostic-design correctness finding, not a new production vulnerability or a finding about the original Windows timeout.

Exact design [`8a26721bbb22cba448c504e3170be1cd2562137a`](https://github.com/Agent-Clubhouse/Clubhouse/blob/8a26721bbb22cba448c504e3170be1cd2562137a/docs/evidence/3774-phase-observation/design.md), tree `7b27add241120f65834f8309fe72a8195da6a2f4`, SHA256 `13f77dc8cd9e595762299d55473e207eafc6ae2e2c465205c819e59cb92f00d7`. This is one document whose direct parent is unchanged approved PR head `e56648cb0952cb29c5045107b635d81f662dae74`. The PR has not been updated by this review.

Reviewer `auto-reset-policy-design` inspected the exact design, baseline fixture/service import/callback path, baseline Vitest/workflow configuration and installed pinned Vitest4.1.12 runner/reporter source. All GitHub work used existing authenticated `gh`; no tests, compiler, lint, native Git experiment, CI run, production/fixture edit, account/settings or access change was performed. Q5 private WIP remains unchanged.

## Finding

| # | Severity | File | Lines | Vulnerability | Confidence |
|---|---|---|---|---|---|
| R1 | Medium; blocks diagnostic implementation | `docs/evidence/3774-phase-observation/design.md` | 18, 28, 37 | Planned `afterEach(context)` calls `context.annotate` after Vitest has already changed the test result from running to pass/fail. It adds a diagnostic hook failure instead of producing the promised final JUnit annotation, including on a successful target case. | High — exact installed runner source; no executed reproduction claimed |

Installed `@vitest/runner/dist/chunk-artifact.js:2368–2370` starts `context.annotate` with a synchronous guard: if `test.result` exists and its state is not `run`, it throws `Cannot annotate tests outside of the test run...`.

The same file's `runTest` sets `test.result.state = 'pass'` after a successful body (2962–2963), or calls `failTask` after a body/setup error (2965–2966), **before** it invokes `afterEach` (2974). Consequently the proposed final call is lifecycle-invalid on both outcomes. Moving it to `onTestFailed` or `onTestFinished` does not solve the already-terminal-state condition. The public type declaration and JUnit annotation serializer do exist; they do not establish that this call site is permitted.

The companion verification JSON preserves package versions, complete dependency-file SHA256 identities and focused numbered source excerpts, plus exact inspected baseline input hashes. This finding does not rely on a timing reproduction or a different Vitest version.

## Minimum correction

Revise the frozen design to use a public output path that remains valid in failure/teardown, preserving the primary test error and all original cleanup. Do not mutate private task/result/annotation state, add a production hook, increase deadlines or change reporter/workflow configuration to make annotation legal.

A small source-supported candidate is to retain early direct stderr markers, then emit the bounded final prepared JSON string through `console.error` in the fixture's existing test context/afterEach rather than call `context.annotate`. Installed JUnitReporter defaults `includeConsoleOutput` to true and serializes task stderr logs into testcase `system-err`. Exact baseline `validate.yml` already selects default+JUnit reporters, and baseline `vitest.config.ts` has no console-interception/silent override. This introduces no annotation await into the original body/deadline. A synchronous console call returning is only an emission observation, not acknowledgment of durable artifact publication; name any replacement publication timing accordingly. **This is feasibility from source only**: the planned disposable unchanged-deadline timeout and controlled `beforeEach` failure must prove actual raw and uploaded-style JUnit capture before any CI observation. A raw stderr line alone is not assumed to become a JUnit property/system-err entry. If the worker/job dies before reporting, partial raw output is the only honest possible evidence.

An alternative public lifecycle-valid publication may be proposed, but must show where it runs while allowed, how it survives setup failure/timeout and how it avoids masking the original failure. No broader framework is requested. Freeze the corrected narrow design for re-review before fixture implementation; exact implementation/proof review still follows before the one normal new-head CI observation.

## Native seam and ownership assessment

I explicitly accept **the concept** of fixture-only native passthrough interception for the otherwise closed-over callback import, subject to exact implementation proof. The baseline service imports callback `execFile` from `child_process`, and calls it once per tracking query with the existing arguments/options/callback and10,000ms native timeout. A Proxy with only `apply`, forwarding `Reflect.apply(target, thisArg, args)` once and returning the identical native ChildProcess, can observe this call without synthesizing Git/tracking results, replacing callbacks or using a generic promisifier.

No property/prototype/construct trap should be added. Native own descriptors/prototype/name/length/custom-promisifier values should remain forwarded; retaining the original custom promisifier intentionally leaves calls through that original custom function uninstrumented. The inspected service path is callback-based, so the diagnostic must not silently substitute a promisified path. Function identity and native `toString` reflection differ and remain disclosed. This is not universal namespace/reflection equivalence or executed Windows forwarding proof.

Required implementation invariants are narrow and practical:

- Observer begin/end/write/close/freeze work must be best-effort and nonthrowing relative to application/native work. It must not prevent or multiply native invocation, mask a synchronous native error, replace callback arguments/results, change returned child identity, add an unhandled rejection or skip the original captured `stop()` cleanup. A logging/annotation failure must not replace the original timeout/setup assertion. The observer is allowed to perturb timing; that cost remains explicit, not a cause claim.
- Capture the original recorder in body scopes and each native close observer at invocation. Late completions must not consult a subsequently active case/global recorder. Freeze before final publication, suppress all later writes to that record, detach only the recorder's own abort/close observers and release its own references. Do not cancel/wait for unfinished native/application work or move grant cleanup into afterEach. Case-window timing must not be overstated as causal attribution of unrelated work.
- A timeout snapshot and final snapshot stay distinct and immutable. A native child closing means that event was observed, not Git success. Synchronous Git can block the event loop beyond the nominal5-second deadline; begin markers and elapsed phase intervals are observations, not an exact timer-fire timestamp. Final output must keep genuinely unfinished scopes incomplete.
- Keep the static field/phase allowlist, finite relative numbers,32-transition retention bound and explicit overflow/drop accounting. Native arguments/options/paths/environment/output/errors/IDs must never enter the payload. Bound raw transition emission as well as retained history; freeze/overflow must not produce unbounded diagnostic output.

The planned exact-source controls should verify native forwarding/metadata and a late close against a retired recorder, plus the raw/JUnit failure paths, without changing original operation order, assertions, grants, native callback options or deadlines. These are diagnostic proof obligations, not a request to investigate or fix unrelated framework behavior.

## Disposition and limits

R1 is the minimum correction needed now. No fixture implementation, new-head CI update or failed-run rerun is approved by this blocked design verdict. The existing #3714 source approval `592f4bdae8d22515c4fd6b434b8ded81a7a5310f` stands unchanged. The original failing run and unresolved investigation `1df05ad1aa681ca0253d8898f93369d986f4858e` remain separate; local native-Git timing and JUnit hook-inclusive duration still do not prove the Windows phase or a flake.
