# MCP binding callable identity (#3738)

Source is frozen at `807360c543a28848e9359564b7917d0bac425e91`, branch `fix/3738-stable-binding-name`, based on main `69ef383cefec405d811f1c199f25c10cdc0395b6`. This evidence-only branch adds no source changes to that commit. Independent final QA is required; no PR, merge, release, live probe, settings/access change, restart or install was performed.

## Results and discriminators

| Receipt | Result | Meaning |
| --- | --- | --- |
| `baseline.log` | 2 failed / 125 skipped, exit 1 | Initial actual `updateBinding` ID-to-name hydration discriminator on unchanged main production. Both Claude and fixed-list Codex repeat the exact name/arguments and receive `no_binding`. |
| `baseline-replay.*` | 2 failed / 130 skipped, exit 1 | Portable repetition with final tests: temporarily restore the two production files from main, then restore successor bytes in `finally`. Records base, command and pre/baseline/post hashes. |
| `incarnation-baseline.*` | 2 failed, exit 1 | On superseded `973c002807aa4592c840bbceecc805ac6c1bb8cf`, same/reversed process rebuilds reuse old names. Reversed order actually forwards each stale name to the other authorized target. This is a retained defect, not accepted behavior. |
| `importers-exact.*` | 522 passed / 12 files, exit 0 | Exact frozen source, including registry/binding/bridge, actual agent/group tools, delegation, delivery, persisted rebuilds, switches, grants, real template inventory and process isolation. |
| `typecheck-exact.*` | exit 0 | Full `tsc --noEmit` on frozen source. |
| `lint-exact.*` | exit 0; 0 errors / 8 warnings | Changed files only. Warnings are on retained catch/`any` lines. |
| `mutation-incarnation.*` | 1 failed / 3 skipped, exit 1 | Remove process namespace, retain generation. Reversed-order control detects actual wrong-target forwards. Original bytes restored. |
| `mutation-display.*` | 2 failed / 130 skipped, exit 1 | Return the mutable display key. Original hydration failure returns. Original bytes restored. |
| `focused-development.*` | 13 failed / 285 passed, exit 1 | Retained first importer failure: local-wake fixtures reconstructed descriptors instead of using the actual wire lifetime. Fixture repair reads the live binding; production authorization was not changed. |
| `importers-development.*` | 2 failed / 519 passed, exit 1 | Retained broader fixture discovery: capture a real stale name before unbinding; select the actual other caller's wire for sleeping hints. Authorization assertions remain. |

Every exact check records HEAD before/after and SHA-256 before/after for all changed source files. Both mutation records include the exact substitution and mutated/restored hashes. `manifest.json` commits source/test/dependency hashes and limits. `SHA256SUMS` seals every evidence file except itself. Raw logs are unedited; local absolute worktree paths remain in them. Initial baseline commands are in the raw gate START lines; replay commands are structured in their JSON records.

`admission-refusals.log` is separate from test outcomes. It retains the refusals written after the ledger was introduced; earlier repeated `other_test_running` refusals remain in the task's tool transcript. No refusal is a test pass. All executable checks used the existing desktop gate (4 GB focused/mutation/lint, 6 GB typecheck), one Vitest worker. No gate edits or reservations were used. The worktree symlink reused an existing dependency store with matching lock SHA-256 `bd9cc80304b81d317f2ffb295d9af5abbc484bf8efb64fc8d7f118e1288c212d`.

## Lifetime and name constraints

An agent/group binding receives its key before `bind` exposes it or notifies listeners. The key is held in a WeakMap keyed by the actual binding. In-place relabel and duplicate bind/rebuild retain it. Removing a wire, target or caller and rebinding creates a new generation. Old names match no current binding; there is no stale-name alias or permission shortcut. Registry resets do not reset the process namespace/counter. A true process restart creates a fresh namespace; old lists fail closed even when binding order reverses. Independent module graphs with deterministic crypto model both orders; they are not live app restart probes.

The namespace is a cryptographic random 128-bit value encoded as exactly 25 base36 characters. It is a public correlation identifier, never an authorization token. For `n` independently generated process namespaces the collision probability is at most `n(n-1)/2^129` (about `1.47e-27` at one million processes). A per-process uint32 generation runs from 1 through `4,294,967,295`; its base36 form occupies at most 7 characters. The next allocation throws before exposing a binding or notifying listeners. Entropy failure aborts module initialization rather than selecting a fallback namespace. No counter or namespace is persisted.

The identity consists of all 25 namespace characters, one underscore, and all generation characters: at most 33. Only the initial readable project/name prefix is shortened, and it disappears at the maximum generation. The UINT32_MAX test verifies the exact untruncated identity, 64-character complete agent name, and exhaustion without wrap. No retired-name collection grows under churn; only weakly held bindings plus fixed-size namespace/counter state remain.

The test registers **all real tools through `registerClubhouseMcpTools`**, including Handoff templates. The longest agent suffix is 18 characters; the longest group suffix is 16. Complete advertised name bounds are `11 + 33 + 2 + 18 = 64` for agent tools and `7 + 33 + 2 + 16 = 58` for group tools. `call_wire_tool` remains the 14-character global tool and resolves the live binding before making its separately authorized inner call. Future longer suffix registrations must maintain the tested budget. Browser, terminal and plugin naming is outside this change.

Names contain only ASCII letters, digits and underscores, a subset of the [MCP tool naming specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#tool-names). These checks cover the server's advertised names; any extra provider-side namespace, transformation or live acceptance remains unproven. No provider/app probes were authorized or run.

## Display provenance and current authorization

Frozen prefixes describe initial metadata. Refreshed tool descriptions use current binding display data, with explicit allowlisted fields: target display name (or public binding label), project display name, and public target ID/address. C0/C1, Unicode format, line and paragraph controls are removed; display name/project/address bounds are 128/128/256 characters, with an ellipsis if oversized. Normal durable ID plus complete machine fingerprint addresses fit intact. The attribution JSON block is bounded to 3,200 characters even with worst-case JSON surrogate escaping. No `projectPath`, private configuration, instruction object or arbitrary binding fields are spread into this block. Same-name targets remain distinguishable by project/address. This adds a modest prompt-text surface: a published name that previously appeared only as a sanitized tool-name fragment now also appears as JSON-quoted, bounded target data. It is not an instruction source or an authorization source. A fixed-list client keeps its original description until it requests a refreshed list; callable identity remains valid across hydration.

Field provenance: `McpBinding.targetName`/`projectName` are explicitly documented human-readable names. MCP binding IPC derives the project field from `project.displayName || project.name`; orchestrator connections map project paths to `projectStore.list()` display/name fields rather than exposing the path; network connections use the published remote agent name or its public durable ID. Binding labels are public wire display labels. Persisted relabel forwards only those same label/name fields. The test plants synthetic `projectPath`/private configuration fields and verifies they never appear in descriptions.

Production consumers were audited: registry listing and lookup, bridge activity lookup, agent-tool reverse reply names/Dispatcher hints/`call_wire_tool`, and group-project delivery all obtain the actual object from `bindingManager`. Only test fixtures reconstructed descriptors or eagerly cached names before a binding existed; they now resolve the actual binding at test execution time. No production descriptor-copy compatibility fallback was added.

After stable-name lookup, existing caller access, current wire switches, tool groups, grant checks, target/host forwarding and remote-side authorization remain authoritative. Receipt equality is still strict. This proof demonstrates routing through the normal forwarding boundary; it does not claim transport deduplication or live P8 acceptance. P8 drafts #3736/#3721 and their strict duplicate assertions were untouched. Refused federation review `966a`/HTTP422, live settings/access, releases and restarts remain outside this work.

## Portable replay

With this checkout and its already-matched dependencies:

```sh
python3 docs/evidence/mcp-stable-binding-name/replay.py verify
python3 docs/evidence/mcp-stable-binding-name/replay.py importers-exact --gate /path/to/desktop-test-gate.sh --output /tmp/qa-3738
python3 docs/evidence/mcp-stable-binding-name/replay.py typecheck-exact --gate /path/to/desktop-test-gate.sh --output /tmp/qa-3738
python3 docs/evidence/mcp-stable-binding-name/replay.py lint-exact --gate /path/to/desktop-test-gate.sh --output /tmp/qa-3738
python3 docs/evidence/mcp-stable-binding-name/replay.py baseline --gate /path/to/desktop-test-gate.sh --output /tmp/qa-3738
python3 docs/evidence/mcp-stable-binding-name/replay.py mutation-incarnation --gate /path/to/desktop-test-gate.sh --output /tmp/qa-3738
python3 docs/evidence/mcp-stable-binding-name/replay.py mutation-display --gate /path/to/desktop-test-gate.sh --output /tmp/qa-3738
```

The script verifies source/dependency/artifact hashes, preserves the supplied gate's real exit code, captures raw output and restores transient baseline/mutation edits in `finally`. Expected RED commands exit 1; resource refusals exit 75 and must follow the gate's retry interval/deadline. It never installs, changes the gate or retries automatically.
