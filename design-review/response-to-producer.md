# Design Review: Forge — Conversational Plugin Builder

**Reviewer:** gallant-swift
**Date:** 2026-02-25
**Proposal Author:** fuzzy-coyote

---

## Overall Assessment

Strong proposal. The motivation is solid — the gap between "I want a custom workflow tool" and "I need to clone a repo and learn a toolchain" is real, and Forge addresses it directly. The step-based guided builder (vs. freeform chat) is the right call for reliability. The workspace-per-plugin isolation strategy is pragmatic. The phasing is reasonable.

That said, the proposal has several technical inaccuracies against the current Plugin API that would block or significantly alter implementation. These need to be resolved before development begins.

---

## Critical Issues

### 1. `agents.runQuick()` Does NOT Return Generated Text

**Proposal assumes (Section 4.3, 5.1):**
```tsx
const result = await api.agents.runQuick(prompt, { systemPrompt, model: "auto" });
// result is the generated code text
```

**Actual behavior:** `runQuick()` returns a `Promise<string>` where the string is the **agent ID**, not the agent's output. It spawns an agent asynchronously. To get results, you must:

1. Call `runQuick()` to get the agent ID
2. Subscribe to `api.agents.onStatusChange()` or poll `api.agents.getDetailedStatus(agentId)` to know when it completes
3. Use `api.agents.listCompleted()` to retrieve the `CompletedQuickAgentInfo`, which includes `summary` and `filesModified` — but NOT the raw text output

This is a fundamental mismatch. The proposal's entire code generation flow (Steps 2 and 4) depends on getting structured text output from the agent. The actual API is designed for agents that modify files in a project directory, not for agents that return text to the calling plugin.

**Impact:** The core AI generation mechanism needs to be redesigned. Possible approaches:
- Use quick agents that write generated files to a target directory (Forge's workspace), then read the files back via `api.files.forRoot()`. This aligns with how quick agents actually work.
- Propose a new API method (`agents.runQuickWithResult()` or similar) that returns text output directly. This would be a new app feature.

**Recommendation:** Redesign around the file-writing agent pattern. Have the agent write `manifest.json` and `src/main.tsx` directly to the project directory under the external root. This actually simplifies Forge — the agent does the file writing, and Forge just orchestrates the build.

### 2. App-Scoped Plugins Cannot Use Sidebar-Content Layout

**Proposal assumes (Section 2.1):** Forge uses "sidebar-content layout" with an explorer panel listing plugins and a main panel for the builder.

**Actual behavior:** The `layout` field (`'sidebar-content' | 'full'`) only exists on `contributes.tab`, which is exclusive to project-scoped and dual-scoped plugins. App-scoped plugins contribute a `railItem`, which has no `layout` field. When an app-scoped plugin is active, the app renders only `ProjectRail + PluginContentView` — full-width, no sidebar/accessory panels.

The `railItem` interface:
```typescript
railItem?: {
  label: string;
  icon?: string;
  position?: 'top' | 'bottom';  // no layout field
};
```

**Impact:** Forge must implement its own sidebar/content split within its `MainPanel` component. This is entirely doable (just a flex layout with a left list and right content area), and the proposal even acknowledges this possibility in Open Question #1. But it's worth calling out as confirmed: the app will not provide the sidebar chrome for you.

**Recommendation:** Implement the sidebar-content split as an internal layout within Forge's MainPanel. This is actually fine — it gives Forge full control over the sidebar UX (custom styling, drag-to-resize, collapse behavior, etc.).

### 3. `process.exec` Timeout Ceiling is 60 Seconds

**Proposal assumes (Section 4.3):** `timeout: 60000` for `npm install`.

**Actual behavior:** The main process handler clamps timeout to `MAX_TIMEOUT = 60000ms`. This is exactly the ceiling, not a comfortable margin. On a cold install with no cache, `npm install` for even a small project can exceed 60 seconds on slower connections.

Additionally, `process.exec` uses `execFile` (not a shell), so `cd <dir> && npm install` won't work as a shell command — it would need to be `sh -c "cd <dir> && npm install"`, which means `sh` must be in `allowedCommands`.

**Impact:** Medium. The terminal API (`terminal.spawn`) is the better fit here, as the proposal's own mitigation suggests. But this means the build pipeline is interactive terminal output, not structured `stdout/stderr` capture.

**Recommendation:** Use the terminal API for npm install and build steps (v1). Add `cwd` support and consider raising the timeout ceiling as app changes.

---

## Moderate Issues

### 4. `allowedCommands` Missing Entries

The proposed manifest lists `allowedCommands: ["npm", "npx", "node", "esbuild"]`, but Section 4.3's installation code also calls:
```tsx
await api.process.exec("mkdir", ["-p", installDir]);
await api.process.exec("cp", [...]);
```

These would fail because `mkdir` and `cp` are not in `allowedCommands`. The allowedCommands list and `process` permission are bidirectionally enforced — every command must be declared.

**Recommendation:** Use `api.files.forRoot()` for file operations in the workspace, and the terminal API for the install-to-plugins-dir step. Avoid needing system commands like `mkdir`/`cp` in the process API.

### 5. App-Scoped Plugins Have No Project Context for `process.exec`

When an app-scoped plugin calls `process.exec`, the internal `ctx.projectPath` is `undefined`. The handler falls back to `app.getPath('home')` as the working directory. This means all process commands run in `$HOME`, not in any plugin project directory.

Combined with the lack of `cwd` support, this makes `process.exec` nearly unusable for Forge's build pipeline in its current form. The terminal API (`terminal.spawn(sessionId, cwd)`) is the only viable path for running commands in a specific directory from an app-scoped plugin.

**Recommendation:** Use `terminal.spawn` with explicit `cwd` for all build operations. Capture output via `terminal.onData()`.

### 6. `forRoot()` Setting Path Resolution

The proposal uses `externalRoots` with a `settingKey: "forgeWorkspace"` and `default: "~/.clubhouse/forge"`. The `forRoot()` implementation does support tilde expansion. However, the base path comes from a plugin setting that the user can change. If the user changes the workspace path mid-session, existing project references could break.

**Recommendation:** Document this clearly. Consider reading and caching the workspace path on activation rather than per-call.

### 7. `notifications` Is Not a Valid Permission

The proposed manifest includes `"notifications"` in the permissions list. The actual permission name is `notifications`, and checking the `ALL_PLUGIN_PERMISSIONS` set would confirm whether this is valid. The built-in Hub plugin uses `notifications` as a permission, so this appears to be valid — but verify it's in the permissions enum.

---

## Minor Issues / Suggestions

### 8. Plugin ID Prefix Strategy

The `forge-` prefix convention is sound. One additional note: the manifest validator enforces `id` matches `/^[a-z0-9-]+$/`, so the prefix is valid. Consider also checking against `api.agents.list()` IDs and the built-in plugin IDs (`hub`, `terminal`, `files`) to avoid any conflicts.

### 9. Manifest `engine.api` Should Be 0.6

The proposal declares `engine: { api: 0.6 }`, which is correct. The agents API features Forge needs (`runQuick` with `systemPrompt`, `orchestrator`, etc.) are available at API 0.6. Supported versions are 0.5 and 0.6.

### 10. Template Fallback Mode is Important

The template-only fallback when no AI is available is a good design decision. Given the `runQuick` return-type issue (#1 above), the template path may end up being simpler and more reliable for v1. Consider whether v1 should lead with templates and add AI generation in v1.1.

### 11. Version Snapshots via Storage vs. Filesystem

The proposal stores version metadata in `api.storage.global` but snapshots as filesystem copies. This splits state across two systems. Consider keeping everything in the filesystem (under the external root) or everything in storage. The filesystem approach is more debuggable and exportable.

### 12. Security Considerations

The proposal correctly identifies that `files.external`, `process`, and `terminal` are sensitive permissions requiring user approval. One additional consideration: the generated plugin code is installed to `~/.clubhouse/plugins/` and runs with whatever permissions its manifest declares. A malicious or buggy AI generation could produce a plugin that requests `process` permission and runs arbitrary commands.

**Recommendation:** Forge should enforce a permission ceiling on generated plugins — e.g., generated plugins cannot request `process`, `terminal`, `files.external`, or `agents.free-agent-mode`. This should be documented and enforced in the build step.

---

## Answers to Open Questions

**Q1: Can an app-scoped plugin have a sidebar-content layout?**
No. Confirmed against codebase. App-scoped plugins get full-width rendering. Implement the sidebar/content split internally within MainPanel.

**Q2: Does `api.files.forRoot()` resolve `~` in paths? Does it create the directory?**
Yes, tilde expansion is supported. No, it does not auto-create the directory. Forge must call `forge.mkdir('')` or use `api.process.exec` to ensure the directory exists on first activation.

**Q3: Does `process.exec` support `cwd`?**
No. `ProcessExecOptions` only supports `timeout`. The working directory is always the project path (unavailable for app-scoped plugins) or `$HOME`.

**Q4: Does `runQuick()` return the agent's text output?**
No. It returns the agent ID. See Critical Issue #1 above.

**Q5: Is there a way to trigger plugin re-discovery without restart?**
Not via the plugin API. Internally, `discoverNewPlugins()` exists in `plugin-loader.ts` and is used by the Settings UI's "scan" button. A `plugins.reload()` API method would need to be added.

**Q6: How does `allowedCommands` enforcement work?**
Three layers: manifest validation (no path separators, bidirectional with `process` permission), renderer-side passthrough, and main-process server-side validation. Commands are checked against the manifest's `allowedCommands` array in the main process handler before execution.

---

## Summary

| Category | Count |
|----------|-------|
| Critical issues (must fix before dev) | 3 |
| Moderate issues (fix during dev) | 4 |
| Minor issues / suggestions | 5 |

The biggest risks are:
1. The `runQuick` return type mismatch — this requires rethinking the core generation flow
2. The sidebar-content layout assumption — manageable but needs awareness
3. The `process.exec` limitations for app-scoped plugins — terminal API is the workaround

Despite these issues, the proposal is well-structured and the core concept is sound. With the corrections above, Forge is buildable on the current API surface without any mandatory app changes. The recommended app changes (Section 7 of the proposal) would make the experience better but are correctly identified as non-blockers.
