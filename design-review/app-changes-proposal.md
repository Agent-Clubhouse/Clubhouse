# Proposed App Changes for Forge Support

**Author:** gallant-swift
**Date:** 2026-02-25
**Context:** Changes to the Clubhouse main app that would support or improve the Forge plugin builder proposal by fuzzy-coyote.

---

## Overview

Forge can ship on the current API surface (v0.6) with workarounds, but several targeted app changes would significantly improve the experience. This document categorizes them by priority and provides implementation details grounded in the actual codebase.

---

## Tier 1 — High Impact, Low Effort

These changes have outsized impact relative to their implementation cost.

### 1.1 Add `cwd` to `ProcessExecOptions`

**Why:** App-scoped plugins have no project context, so `process.exec` defaults to `$HOME` as the working directory. Forge needs to run `npm install` and `npm run build` in specific project directories under `~/.clubhouse/forge/projects/`. Without `cwd`, the only option is the terminal API (which works but loses structured stdout/stderr capture).

**Current state:**
- Type: `src/shared/plugin-types.ts` line 578 — `ProcessExecOptions` has only `timeout`
- Handler: `src/main/ipc/process-handlers.ts` — uses `projectPath || app.getPath('home')` as cwd
- Factory: `src/renderer/plugins/plugin-api-factory.ts` line 1463 — passes `ctx.projectPath`

**Proposed change:**

```typescript
// plugin-types.ts
export interface ProcessExecOptions {
  timeout?: number;
  cwd?: string;  // Working directory for the command. Must be within project root or an approved external root.
}
```

```typescript
// process-handlers.ts — add cwd resolution with security check
const cwd = options?.cwd || projectPath || app.getPath('home');
// Validate cwd is a real directory and within allowed paths
```

**Security consideration:** The `cwd` must be validated. Options:
- Allow any absolute path (simple but loose)
- Restrict to project root or declared `externalRoots` paths (tighter, aligns with existing file access scoping)
- For Forge specifically, the `cwd` would be within `~/.clubhouse/forge/` which is already an approved external root

**Files to modify:**
| File | Change |
|------|--------|
| `src/shared/plugin-types.ts` | Add `cwd?: string` to `ProcessExecOptions` |
| `src/main/ipc/process-handlers.ts` | Read `cwd` from options, validate, use as working directory |
| `src/renderer/plugins/plugin-api-factory.ts` | Pass `options.cwd` through to IPC call |
| `src/renderer/plugins/plugin-api-version-contracts.test.ts` | Update contract tests |

**Effort:** Small (4 files, ~30 lines of logic + validation)

---

### 1.2 Add `plugins.reload()` / `plugins.discoverNew()`

**Why:** After Forge builds and installs a plugin to `~/.clubhouse/plugins/`, the user must manually navigate to Settings > Plugins for the app to pick it up. This breaks the magic of the guided flow. A `plugins.reload()` method would let Forge trigger re-discovery programmatically.

**Current state:**
- `discoverNewPlugins()` already exists in `src/renderer/plugins/plugin-loader.ts` (line 466) — scans for new plugins without disrupting existing ones
- `hotReloadPlugin(pluginId)` exists in the same file (line 381) — full teardown/re-activate cycle
- The Settings UI calls `discoverNewPlugins()` via a "scan" button in `PluginListSettings.tsx`
- Neither function is exposed through the Plugin API

**Proposed change:**

Add a `plugins` namespace to `PluginAPI`:

```typescript
// plugin-types.ts
export interface PluginsAPI {
  /** Trigger re-scan of ~/.clubhouse/plugins/ for newly added plugins. */
  discoverNew(): Promise<string[]>;  // Returns IDs of newly discovered plugins

  /** List all installed plugins and their status. */
  list(): PluginListEntry[];

  /** Reload a specific plugin from disk (re-read manifest, re-activate). */
  reload(pluginId: string): Promise<void>;
}

export interface PluginListEntry {
  id: string;
  name: string;
  version: string;
  scope: 'project' | 'app' | 'dual';
  status: 'active' | 'inactive' | 'incompatible' | 'error';
  enabled: boolean;
}
```

**Permission:** This should require a new `plugins` permission. Only plugins that explicitly need to manage other plugins (like Forge) would request it.

**Security consideration:** `reload()` and `discoverNew()` affect the entire plugin system. Restrict to plugins with the `plugins` permission. Consider whether a plugin should only be able to reload plugins it installed (tracked via a `forge-` prefix or metadata).

**Files to modify:**
| File | Change |
|------|--------|
| `src/shared/plugin-types.ts` | Add `PluginsAPI` interface, add to `PluginAPI`, add `'plugins'` permission |
| `src/renderer/plugins/plugin-api-factory.ts` | Create `createPluginsAPI()`, wire into factory |
| `src/renderer/plugins/plugin-loader.ts` | Ensure `discoverNewPlugins()` returns new IDs |
| `src/renderer/plugins/manifest-validator.ts` | Recognize `'plugins'` as valid permission |
| `src/renderer/plugins/plugin-api-version-contracts.test.ts` | Update contract tests |

**Effort:** Small-Medium (5 files, ~80 lines)

---

### 1.3 Raise `process.exec` Timeout Ceiling

**Why:** The current max timeout is 60,000ms (60s). `npm install` on a cold cache can exceed this. Forge's build pipeline runs `npm install` + `npm run build` sequentially.

**Current state:** `src/main/ipc/process-handlers.ts` defines:
```typescript
const MIN_TIMEOUT = 100;
const MAX_TIMEOUT = 60_000;
const DEFAULT_TIMEOUT = 15_000;
```

**Proposed change:** Raise `MAX_TIMEOUT` to 300,000ms (5 minutes). This is still bounded and prevents runaway processes, but accommodates longer-running build tools.

Alternatively, add a `longRunning` flag to `ProcessExecOptions` that unlocks a higher ceiling (e.g., 5 minutes) so the default behavior stays conservative.

**Files to modify:**
| File | Change |
|------|--------|
| `src/main/ipc/process-handlers.ts` | Raise `MAX_TIMEOUT` constant |

**Effort:** Trivial (1 line)

---

## Tier 2 — Medium Impact, Low-Medium Effort

### 2.1 Add `plugins.enable(pluginId)`

**Why:** After Forge installs and discovers a new plugin, the user still has to manually enable it in Settings. Programmatic enable would complete the zero-friction flow.

**Current state:** Plugin enable/disable is managed via `usePluginStore` state (`appEnabled` / `projectEnabled` arrays) and persisted to `~/.clubhouse/plugin-prefs.json`. The Settings UI toggles these directly.

**Proposed change:** Add to the `PluginsAPI`:

```typescript
enable(pluginId: string): Promise<void>;
disable(pluginId: string): Promise<void>;
```

**Security consideration:** This is powerful — a plugin enabling another plugin could create unexpected behavior. Options:
- Only allow enabling plugins with the `forge-` prefix
- Require user confirmation via `api.ui.showConfirm()` before enabling
- Only allow enabling plugins that are currently `inactive` (discovered but not enabled)

**Effort:** Small (builds on the PluginsAPI from 1.2)

---

### 2.2 App-Scoped Sidebar-Content Layout Support

**Why:** Forge's UX is designed around a sidebar (plugin list) + main panel (builder/detail). Currently, app-scoped plugins get full-width rendering only. Forge can implement its own split layout internally, but first-class support would be more consistent with the project-scoped plugin experience.

**Current state:**
- `railItem` has no `layout` field (only `label`, `icon`, `position`)
- `tab` supports `layout: 'sidebar-content' | 'full'`
- `App.tsx` renders app plugins as `ProjectRail + PluginContentView` with no sidebar

**Proposed change:** Add `layout` to `railItem`:

```typescript
railItem?: {
  label: string;
  icon?: string;
  position?: 'top' | 'bottom';
  layout?: 'sidebar-content' | 'full';  // default: 'full'
};
```

When `layout: 'sidebar-content'`, the app would render the plugin's `SidebarPanel` (exported from its module) alongside its `MainPanel`, using the same `AccessoryPanel` + `ResizeDivider` chrome that project-scoped plugins get.

**Files to modify:**
| File | Change |
|------|--------|
| `src/shared/plugin-types.ts` | Add `layout` to railItem type |
| `src/renderer/App.tsx` | Branch on `railItem.layout` in the app-plugin rendering path |
| `src/renderer/panels/AccessoryPanel.tsx` | Handle app-plugin sidebar rendering |
| `src/renderer/plugins/manifest-validator.ts` | Validate new field |

**Effort:** Medium (rendering path changes require careful testing)

**Alternative:** Forge implements its own internal sidebar. This is simpler for the app team and gives Forge full control. The trade-off is slight visual inconsistency with the native sidebar chrome.

**Recommendation:** Defer this. Let Forge implement its own sidebar for v1. If other app-scoped plugins also want sidebar-content layout, revisit as a platform feature.

---

### 2.3 Quick Agent Text Result API

**Why:** The current `agents.runQuick()` returns an agent ID, not the agent's output. The agent runs autonomously and modifies files. For Forge's code generation use case, a simpler "send prompt, get text back" pattern would be more natural.

**Current state:** `runQuick()` spawns an agent that operates on files in a project directory. Results are retrieved via `listCompleted()` which returns `CompletedQuickAgentInfo` with `summary` and `filesModified`.

**Proposed change:** Add a complementary method:

```typescript
// Runs a quick agent and returns its text output directly (blocks until complete)
runQuickWithResult(mission: string, options?: {
  model?: string;
  systemPrompt?: string;
  timeout?: number;
}): Promise<{ result: string; exitCode: number }>;
```

This would be a higher-level wrapper that spawns the agent, waits for completion, and returns the summary/output as a string.

**Alternative (no app change):** Forge can work with the existing API by:
1. Calling `runQuick()` to spawn the agent with instructions to write files to the external root
2. Subscribing to `onStatusChange()` to detect completion
3. Reading the generated files via `api.files.forRoot()`

This file-writing pattern actually aligns better with what quick agents are designed to do. The agent writes code files; Forge reads and builds them.

**Recommendation:** Defer this. The file-writing pattern works well enough for Forge and is more aligned with the agent architecture. A text-result API could be useful for other use cases but isn't a Forge blocker.

---

## Tier 3 — Future / Nice-to-Have

### 3.1 Filesystem Watch for Plugin Directory

Auto-detect new or changed plugins in `~/.clubhouse/plugins/` without manual reload.

**Implementation:** Use `fs.watch` or `chokidar` on the plugins directory in the main process. Debounce and trigger `discoverNewPlugins()` on new directories, `hotReloadPlugin()` on file changes within existing plugin directories.

**Effort:** Medium. Filesystem watching is straightforward but needs careful debouncing and error handling (especially on macOS with FSEvents).

### 3.2 Process `stdin` Support

Allow passing stdin data to `process.exec`. Useful for piping data to build tools.

**Effort:** Medium. Requires changing the IPC protocol to support streaming or buffered stdin.

### 3.3 Plugin Workspace API

First-class app support for plugin development workflows: create project, scaffold files, build, install, test. This would essentially promote Forge's core logic into the app platform.

**Effort:** Large. Only worth doing if Forge proves the concept and multiple tools want similar capabilities.

---

## Summary

| Change | Tier | Effort | Forge Impact |
|--------|------|--------|-------------|
| `ProcessExecOptions.cwd` | 1 | Small | Eliminates need for terminal API workaround in build pipeline |
| `plugins.discoverNew()` / `plugins.reload()` | 1 | Small-Med | Enables seamless install-to-enable flow |
| Raise process timeout ceiling | 1 | Trivial | Prevents npm install timeouts |
| `plugins.enable(id)` | 2 | Small | Completes zero-friction install flow |
| App-scoped sidebar-content layout | 2 | Medium | Native sidebar chrome (defer — Forge can DIY) |
| `agents.runQuickWithResult()` | 2 | Medium | Simpler code gen flow (defer — file-writing pattern works) |
| Filesystem watch on plugins dir | 3 | Medium | Auto-discovery without explicit reload |
| Process stdin | 3 | Medium | Edge case build tool support |
| Plugin workspace API | 3 | Large | Platform-level plugin dev support |

**Recommended for Forge v1 launch:** Tier 1 items only (cwd, plugins API, timeout). Total effort: ~120 lines of production code across 8 files, plus tests.

**Not required for Forge v1:** Everything in Tier 2 and 3. Forge can ship with workarounds (terminal API for builds, internal sidebar layout, file-writing agent pattern).
