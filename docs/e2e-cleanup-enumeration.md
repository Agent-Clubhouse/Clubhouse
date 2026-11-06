# Bounded process enumeration for local E2E cleanup

The cleanup safety test in candidate `e43a3daa8` timed out on Windows in
CI42154979699. Its JUnit duration was35.8808042s against the existing30000ms
limit. This is separate from the original three catalog/feedback timeouts, which
passed in that run. The old log cannot establish whether probe-wait scheduling
or process enumeration consumed the time. The timeout cause remains unresolved.

The old cleanup synchronously invoked PowerShell/Get-CimInstance with no timeout.
That blocks JavaScript, including Vitest's timeout callback. Vitest4.1.12 also
checks elapsed time after the body resolves, so an overlong synchronous operation
can be reported only after returning. Adding only an execFileSync timeout would
still wait for child exit. See [Node's synchronous process documentation](https://nodejs.org/api/child_process.html#child_processexecfilesyncfile-args-options).

The proposed test-infrastructure correction uses asynchronous execFile with the
same fixed process-table commands and a10000ms query deadline. It leaves the
existing30000ms test limit and target safety assertions intact. Only the created
enumerator child is eligible for deadline cleanup. Requested signalling and
observed close are distinct; a request, error or late callback cannot release
the query reservation. Another query is refused until the actual close event.
A failed cleanup detaches optional stream/worker handles without claiming exit.
It does not wait indefinitely for process termination or launch replacement
enumerators alongside an unresolved one.

Timeout, query failure, malformed output and unresolved worker are unknown
snapshots. They permit no target kill, temp-directory removal or state deletion.
The recorded launch file and temp data remain available for a later safe sweep.
The PID-record, repo-local Electron predicate and descendant targeting are
unchanged. Negative safety tests additionally require a complete snapshot, so
failed enumeration cannot silently count as an observed safety pass.

The first safety case records separate fixed phases for probe visibility,
recording and enumeration/sweep through the existing bounded failure observer.
Query failure emits only reason, elapsed time and cleanup booleans. No process
table, command line, PID, path or raw error enters diagnostic output.

Synthetic fake-runner/timer tests cover query timeout, cleanup refusal/throw,
actual close, late reply, duplicate prevention, malformed data and retained
state/files without any real process enumeration. Existing Node-process safety
fixtures still verify target selection. These tests do not prove a Windows
PowerShell cause, hard OS process termination, or freedom from unrelated event
loop stalls. No app/provider launch or test-limit increase is required.
