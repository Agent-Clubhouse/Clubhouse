# Independent QA source review: #3738 stable binding callable names

Reviewer: qa-details-local-composition. November 20, 2026.
Review target: `973c002807aa4592c840bbceecc805ac6c1bb8cf` on `origin/fix/3738-stable-binding-name`. I verified the remote ref. It has two commits on main `69ef383ce`: `d1b9f4799` and `973c00280`. I read the superseded `d1b9f4799` first, and this report covers the final source.
Method: I read source only and ran nothing. The exact validation evidence is still pending.

## Verdict

**Source looks sound.** I have one decision point, L1, which concerns names after a restart. **Final approval is deferred** until the exact evidence for `973c00280` exists: the hydration baseline (2 FAIL) and a green run bound to the exact head with tsc, lint and manifest. Nothing here implies full duplex acceptance.

## Mechanism

- `binding-tool-key.ts` keeps a module-level `WeakMap<McpBinding,string>` and a global `bigint` generation that only increases.
- `initializeBindingToolKey` runs in `BindingManager.bind` **before** `push` and `notifyChange`, so no listener can observe an unkeyed wire. It applies only to `agent` and `group-project` targets and is idempotent.
- The key is `<project>_<name>_b<gen>` for agents and `<name>_b<gen>` for groups. The generation takes the old 4-character hash slot (`973c00280`).
- `buildToolKey` returns the stored key and otherwise formats a display key, `…_<fnv4>`.
- Other kinds (browser, terminal) are unchanged.

## Checks

- **Same-binding rebuild and hydration:**
  - `updateBinding`, `setDisabledTools` and `setInstructions` change the binding object in place.
  - `getBindingsForAgent` and `getAllBindings` return the originals, never copies.
  - `rebuildPersistedBindings` only prunes unlisted pairs (`unbind`). It never rebinds a listed pair.
  - So display hydration, relabel and rebuild keep the callable name. That fixes the issue's RED case (the name changed after `updateBinding`, then `no_binding`).
- **Consumer descriptor copies:**
  - Every production `buildToolName`/`buildToolKey` caller receives a live binding object: the tool list, `matchScopedToolName`, the bridge-server matcher at :229, `agent-tools` reply names at :85/:255/:451, `call_tool` at :760, and `group-project-delivery` at :452.
  - I found no structured-clone or IPC copy that is used for matching.
  - A copy would fall back to a display key, which can only fail closed: no match, so `no_binding`.
- **Stale callable reuse:**
  - unbind, `unbindAgent`, `unbindTarget` and group or persisted pruning remove the object.
  - A rebind creates a new object with a new generation.
  - Within one process a key can never be reissued, because the generation only increases. Tests cover removal of wire, target or caller followed by an identical replacement.
- **Collisions:**
  - Bound keys are unique within a process. The last `_`-segment is `b<base36 gen>`, sanitized IDs contain only `[A-Za-z0-9_]`, and equal strings imply an equal final segment, which means the same generation and so the same binding.
  - The real short-hash collision between remote machines is isolated (test at :155).
  - Matching also requires the trailing `__` boundary and a real template suffix, so `…_b1__` cannot prefix `…_b12__`.
- **Tool-name syntax and length:**
  - `parseToolName` (`[a-zA-Z0-9_]+` key, `[a-zA-Z_]+` suffix) accepts the new keys.
  - The segment is 2 characters while gen < 36, 3 characters up to 1295 and 4 characters up to 46655, so names are no longer than the old hash names until 46,656 binds in one process.
  - The issue's example goes from 66 to 64 characters.
  - There is no local length cap, and names over 64 characters already existed. I make no claim about what providers accept.
- **Forwarding:**
  - Remote execution forwards `targetId` plus suffix (`forwardAgentCall`, tool-registry.ts:1095), never the key.
  - Machine-local generations therefore never have to agree across hosts.
- **Authorization:**
  - The tool-name change does not touch the receipt, grant, switch or delivery checks. Each call still matches a current binding, then runs the current checks (test at :631).
  - There is no alias or fallback to an old name.

## Findings

**L1: a name can point at a different target after a restart (decision, low to medium).**
- Generations restart at 1 in each process.
- Take two bindings that share a project and display name, such as two remote "robin" agents in project "app" on different hosts. If their bind order changes between runs, `app_robin_b1` can belong to robin@host1 before the restart and to robin@host2 after it.
- A resumed CLI transcript, or a stored reply hint, that still contains the old name would then reach a **different, still-authorized** target.
- This doesn't weaken any grant, but it can misdirect a message. Before this change, names were deterministic across restarts.
- Options:
  - add a short random per-process salt to the generation segment (costs about 2 characters);
  - or accept it and document that names are only stable within a process.
- Please decide this explicitly. If accepted, add a note and ideally a test that pins the boundary.

**O1: tool names keep the bind-time display name (by design, note it).**
- After hydration or relabel, the key keeps the old label. The persisted test asserts the new key equals the pre-claim `Wardfall…` key.
- Descriptions and reply hints carry the current names, so this is acceptable. Help text or notes should say that the name segment is an identifier, not a live label.

## Final evidence needed for approval

1. The baseline RED on `69ef383ce` with only the new tests applied (the owner's 2 FAIL / 125 skip), as the raw log plus the command.
2. A green run bound to `973c00280` with validated head, pre and post status, and exit codes:
   - `tool-registry`, `bridge-server`, `persisted-bindings` and `binding-manager` tests, plus every test that imports `binding-tool-key` or `tool-registry`;
   - `tsc --noEmit`;
   - ESLint on the changed files.
3. A SHA256 manifest of committed `.txt` copies. `*.log` is gitignored.
4. A mutation discriminator: dropping `initializeBindingToolKey` in `bind`, or going back to the display key, makes the hydration test fail.
5. The L1 decision.
