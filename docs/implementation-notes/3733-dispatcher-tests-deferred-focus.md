# #3733 Dispatcher test repair and section 7 deferred focus

Base: accepted `01878a4a50aeaff979b2541c393c3f12def7ea9a`.
Task branch: `DetailsSessionDisplay/dispatcher-tests-focus`.

The two base-reproduced Dispatcher tests expected generic `Loading details` text from Connections. The actual Connections consumer has its own `Loading connections from the host…` text. The old fixture resolved unavailable immediately, while the assertions only flushed microtasks before the parent view's 150ms host-read delay; they never verified unavailable evidence.

Both canonical `__dispatcher__` and ordinary-project Dispatcher cases now explicitly defer the host response, verify pending body/summary copy, then resolve unavailable and verify unavailable body/summary plus the supported legacy Settings read's unavailable result. They assert exact selected host/raw-agent identity and call counts. Existing remote-presence, card applicability and no-local-controls checks remain. Added spies forbid local Dispatcher presence/config reads, local durable mutation and remote spawn/wake/kill. No production Dispatcher changes.

Section 7 deferred focus shares RemoteAgentDetailsView and is disjoint from the Dispatcher test repair. Its only production change mirrors local Details: deduplicate focus by selected namespaced identity, nonce and resolved card, allowing a pending Subagents request to resolve again when hydration exposes that card. Tests require eventual requested-child expansion and stream jump, no repeat reopening after manual collapse, and no focus/late-evidence replay to another host with the same raw agent ID.

Proof:
- Two scoped renderer suites: **84 passed** (AgentDetails 27; RemoteAgentDetailsView 57), 1 worker, no file parallelism.
- Nonce-only predecessor focus discriminator: **1 failed, 1 passed, 55 skipped**; delayed hydration fails the eventual-open assertion, cross-host isolation remains passing.
- Unavailable-as-loading renderer mutation discriminator: **both Dispatcher cases fail**, 25 skipped. Tests retain the pending/unavailable distinction and selected legacy Settings response; they are not merely weaker wording assertions. Temporary mutations restored.
- Final report records exact committed-head suite, typecheck, scoped lint and diff-check results.

Commands:
```
NODE_OPTIONS=--no-experimental-webstorage node_modules/.bin/vitest run --project renderer src/renderer/features/agents/details/RemoteAgentDetailsView.test.tsx src/renderer/features/agents/details/AgentDetails.test.tsx --maxWorkers=1 --no-file-parallelism
node_modules/.bin/tsc --noEmit
node_modules/.bin/eslint src/renderer/features/agents/details/AgentDetails.test.tsx src/renderer/features/agents/details/RemoteAgentDetailsView.tsx src/renderer/features/agents/details/RemoteAgentDetailsView.test.tsx
git diff --check
```

Used the already verified November19 dependency directory; no installs. Node25 native Web Storage disabled for jsdom as in the accepted slice. Tests ran only after the Orchestrator granted the serial heavy lane. Existing non-fatal Vite/jsdom canvas warnings remain.

Deferred: independent new-head review and live app/provider acceptance; all other section7 items and broader #3733 parity. No server, route, protocol, authority or access changes; no PR/merge/release. Original local standby commit remains preserved and unpushed; this follow-up is on its separate task branch.
