# #3733 finite checklist 5(a,b): remote Session display

Base: `4fcae1c956719300b5e052540a37bb9a391bb405`.
Branch: `DetailsSessionDisplay/standby`. Scope is renderer Session usage and elapsed display only.

Changes:
- Preserve token knownness: reported total zero and partial input/output zero display `0 tokens`; absent/empty tokens remain unreported. Explicit totals take precedence; completed-turn fallback and its resumed-history qualification remain. Usage `none` withholds usage values. Existing shared cost formatting remains (including zero-cost `<$0.01`).
- Extract local Details' existing 30-second `useNow` into a shared renderer hook; local behavior is unchanged. Remote live Session body and collapsed summary use that view clock and host spawn time; summary combines duration and reported cost as local Details does. Clock ticks perform no host reads or transcript hydration.
- Activate only for a current host Details read with running state/spawn time, outside Dispatcher and runtime-unconfirmed state. Existing invalidation/stop/revocation fences remain; timer cleans up on stop with failed reread, offline, snapshot loss followed by denial, forbidden reread and unmount.
- No server, route, protocol, auth or access edits. No installation, PR, merge or release.

Proof (single worker, no file parallelism):
- RemoteAgentDetailsView.test.tsx: **55 passed**, including 16 added usage/clock cases. Fake-clock tests advance 30 seconds without host events and assert unchanged Details/chat read counts, body + collapsed summary progress, then timer cleanup/no polling after each transition.
- AgentDetails.test.tsx: **25 passed, 2 failed**. Both failures are existing `AgentDetails for a remote Dispatcher / uses Dispatcher cards for its snapshot record` cases (`__dispatcher__`, `ordinary-project`). The same 25/2 result reproduces with both implementation files restored temporarily to the exact assigned base. These assertions expect synchronous host-backed card text; left outside 5(a,b).
- Negative discriminator: restore predecessor RemoteAgentDetailsView/AgentDetails source temporarily and run the 16 new cases: **11 failed, 5 passed**, 39 existing cases skipped. Failures cover known-zero total/partial/turn sums, zero-cost plus zero-token, usage-none, and all five clock scenarios. Implementation restored afterward.
- `tsc --noEmit`, ESLint on the four changed renderer files, and `git diff --check`: pass.

Commands:
```
NODE_OPTIONS=--no-experimental-webstorage node_modules/.bin/vitest run --project renderer src/renderer/features/agents/details/RemoteAgentDetailsView.test.tsx src/renderer/features/agents/details/AgentDetails.test.tsx --maxWorkers=1 --no-file-parallelism
node_modules/.bin/tsc --noEmit
node_modules/.bin/eslint src/renderer/features/agents/details/AgentDetails.tsx src/renderer/features/agents/details/RemoteAgentDetailsView.tsx src/renderer/features/agents/details/RemoteAgentDetailsView.test.tsx src/renderer/features/agents/details/useNow.ts
git diff --check
```

Dependencies: existing verified `/var/folders/gc/njdn7vz54s7bcppxdlnpf51m0000gn/T/clubhouse-nov19-deps.OiC7J5Jz9G/node_modules`, linked locally; no installs. Node v25.8.1 requires the shown native-Web-Storage workaround for the local suite's jsdom storage. Vite native-config and jsdom canvas warnings remain non-fatal.

Deferred acceptance: independent review of this implementation head, live app/provider observations, the two baseline Dispatcher assertions, and all checklist work outside 5(a,b). Frozen predecessor Source QA belongs to its assigned reviewer and was not repeated. These scoped results do not close #3733 or establish whole-head parity/release acceptance. Final report records the pushed SHA and exact-head rerun results.
