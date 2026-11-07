# Bounded skill source successor to 65b48e396

The immutable original `65b48e396690755bf783378442fce8063353b3cb`, its base
`29fc08713e621abb4c4bed175369ad76608c2a53`, preserved refs, worktrees and
`/private/tmp/builder-skill-workflows-65b48e396` evidence remain intact. Root's
read-only review found insufficient Builder production-path guard coverage and
unjustified native revision-map overrides. This successor addresses those source
findings. Nothing in this successor has been executed or validated.

## Exact supported and unsupported behavior

`builderSnapshotAdoption` retains the original 29fc block rules: start from
composition floors, raise accepted-template block holds with `Math.max`, then
use saved heads for explicit block IDs. The only new holds are direct/base skill
IDs, using the explicit floor if present, otherwise the current saved head.
An asset shared through base and direct skill references gets the same hold.
There is no traversal of native payloads and no new MCP hold construction.

Snapshot construction, Builder read and Builder command independently refuse:

- Any native instance reference in `composition.subagents`.
- An accepted template containing native subagent references or MCP IDs, even
  when the instance excludes those references.
- Any MCP asset ID in explicit additions or removals.

They throw a main-only `BuilderUnsupportedCompositionError`. Valid local-user
Builder IPC read/command returns `{ok:false,code:'unsupported'}` without a view,
snapshot or composition write. A stale command encountered directly by the
service still retains its earlier stale-revision precedence; the IPC snapshot
precheck refuses the unsupported saved composition before dispatching commands.
A supported current composition also cannot switch to an unsupported template:
the target snapshot is refused before template preview/commit. This bounded
editor does not repair or erase unsupported references. The separate activation
adapter's refusals remain unchanged. Native/MCP delivery remains required overall
core work outside this skill slice; no provider support is implied.

The renderer shows the explicit unsupported message and no effective composition
or skill-assignment controls. It does not request the raw instruction composer
while no Builder view is available. Skills-only create/copy/selection/removal and
exact payload preview remain as in the previous handoff. Original shared-consumer
edit refusal and optional main-only serialized source-head guards are unchanged.

## New production Builder IPC fixture map (source definitions, not results)

`src/main/ipc/agent-builder-guards.test.ts` calls
`registerAgentBuilderHandlers()` without an injected store for every case. It
mocks base-dir resolution to an owned `mkdtemp` root, registry/config reads to
synthetic DTOs and Electron registration only. The handler, common context
resolver, real catalog store, existing transition gate and production guarded
synchronous rename closure remain active. Arrangement/observation uses a second
ordinary store pointing at the same owned catalog, never injected into handlers.

| Fixture | Boundary exercised and refusal evidence |
| --- | --- |
| Commits a reviewed skill through real guarded rename | Positive path reaches the production synchronous index rename exactly once and saves the reviewed reference. |
| Path remap between first lookup and ID resolution | Pause first project snapshot, remap its ID to another owned-temp path without changing registry generation, then release. Exact expected-path check refuses; index bytes and synchronous rename count remain unchanged. |
| Pending registry at final commit | Pause real catalog atomic write after file sync and before close/rename; set registry pending, release; production guard prevents synchronous rename. Prior index/composition/additions stay identical. |
| Registry generation at final commit | Same real staging gate; increment registry generation only. Final guard prevents rename and preserves composition. |
| Agent config generation at final commit | Same real staging gate; increment config generation only. Final agent-target guard prevents rename and preserves composition. |
| Helper, disposed, creating and failed target cases | Mutate current synthetic config before confirmed assignment. Real registered context resolver refuses before writing; index bytes/rename count remain unchanged. |
| Transition contention | Hold the actual transition reservation with a deterministic gate, invoke confirmed assignment, observe refusal/no rename/index change, then release and await the holder; reservation must be clear. |
| Stored MCP/native composition | Arrange valid catalog composition with ordinary planner/store, then invoke production Builder read/command. Both return unsupported with no view, rename or index change. |

The staging mock wraps only `fs/promises.open` handles for owned catalog index
staging files. It pauses `sync` after actual sync, leaving the handler's guard and
synchronous rename untouched. A separate `node:fs.renameSync` wrapper counts calls
and delegates to the real implementation. This distinguishes refusal before
commit from a misleading failed response after an index commit.

Every gate has an explicit release in `finally` and an afterEach release safety
net. Every held operation immediately receives a fulfillment/rejection observer,
is awaited in the fixture's `finally`, and is also tracked for afterEach drain
before owned-temp deletion. Waiting for gate entry races the observed operation;
an early failed/completed operation fails the assertion without stranding a gate.
No sleeps, provider calls, real user directories or persistent fixtures are used.

Additional service fixtures cover common direct/base skill hold precedence,
excluded native/MCP template refusal without generated holds, explicit read and
target-template command refusal, and unchanged catalog index. A renderer fixture
asserts unsupported text, absent skill controls and no composer request. Existing
bundle service tests remain service-level evidence; they do not substitute for
these production Builder integration fixtures.

## Root-owned focused validation nomination, not authorization to execute

Independent review must inspect the exact successor and preserved parent first.
Root owns its own offline dependency preparation and the coordinated slot. No
node_modules borrowing/symlinking, install, tests, type/lint, build/app/provider,
CI or push occurred in this source lane.

After root review and preparation, nominate `npm run typecheck`, ESLint limited
to changed TS/TSX paths, and one affected regression invocation:

```sh
npm test -- src/main/ipc/agent-builder-guards.test.ts src/main/ipc/agent-builder-handlers.test.ts src/main/services/asset-catalog/builder.test.ts src/main/services/catalog-skill-bundles.test.ts src/main/ipc/skill-bundle-handlers.test.ts src/preload/skillBundle.test.ts src/shared/ipc-channel-sync.test.ts src/renderer/features/agents/AgentBuilderSection.test.tsx src/renderer/features/agents/AgentBuilderSkills.test.tsx src/renderer/features/skills/CatalogSkillBundleEditor.test.tsx src/renderer/features/settings/SkillLibrarySettingsView.test.tsx --reporter=default
```

The earlier design's transaction ordering, create/copy unassigned behavior,
consumer protection and concrete NewAgent reservation/draft-lifecycle handoff
remain applicable. This successor replaces its generalized native snapshot
behavior and closes its documented Builder production-path fixture gaps; it
does not claim those fixtures passed. Root validation, CI and landing remain.
