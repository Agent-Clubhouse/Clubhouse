# Chrome redesign: implementation spec

Status: draft for review, 2026-10-16
Mockups and decision log: https://claude.ai/artifact/9Y2CkpV9KwkUxRinxL8BJe
Related: [docs/telemetry-otel-spec.md §9.1](telemetry-otel-spec.md), #1933 (split view), #1934 (plugin API vNext)

## 1. Goal and scope

Today, on a 1400px window, the navigation chrome takes 556px of width in three columns, and the agent pane starts at x=566 once the resize dividers are counted:

- the project rail: 76px when the project list scrolls (measured with 18 projects), 70px otherwise (`ProjectRail.tsx:359`)
- a 200px explorer column
- a 280px agent list

Each agent row is 90px tall, so about 8 agents fit on screen. The redesign replaces this with one resizable sidebar (264px by default), 30px agent rows, and project tabs in the existing 38px title bar.

In scope: the project rail, explorer column, agent list, title bar, Settings navigation, the Home view, the first-run state, and window chrome on macOS, Windows and Linux.

Out of scope:
- The agent pane (terminal and chat views) and plugin content views. They render unchanged.
- Popout windows, apart from their title bar.
- Merging the two canvases.
- Split view (#1933).

## 2. Decisions this spec implements

All decided 2026-10-16. The artifact's decision log has the reasoning.

| Area | Decision |
|---|---|
| Layout | One sidebar, top to bottom: host switcher pill, then search and New, then a Canvas and Review row (30px), then “Needs you”, then the project tree, then a footer with the version, Help and Settings |
| Agent rows | 30px single line: status dot, 18px avatar, name, orchestrator glyph, relative time. Chips move to a hover card. The right-click menu is unchanged. Drag reorders within a project only. |
| Needs you | Pinned section listing agents waiting on a permission or in error, across all connected hosts. Remote rows show a host tag. Hidden when empty. Clicking a remote row switches host and opens the agent. |
| Project tree | Projects are collapsible, there is a collapse-all control, drag reorders projects, and projects can be pinned. Order: pinned, then recent activity, then one “N idle projects” row. Inside a project, sleeping agents fold into “N sleeping”, and finished quick agents fold into “N finished quick agents” with per-item Dismiss and Clear all. |
| Idle rule | Unpinned, and no activity for 7 days (configurable). Activity means an agent ran or woke, a quick agent started, or the user opened one of the project's tabs. Sleeping durable agents do not count. |
| Title bar | Project tabs live in the title bar. Overflow goes into a More menu ordered by most recent use, and the active tab is always visible. The breadcrumb shortens to the agent name below about 1100px. No split-view button. |
| Lists | A tab with its own list (`sidebar-content` layout) swaps the sidebar body to that list, with an “Agents / <Tab>” breadcrumb. “Needs you” shrinks to a 30px strip there. Full-layout tabs (Canvas) and Terminal keep the agent tree. |
| Scope | The sidebar selection sets the scope. Selecting an agent row points Terminal, Files and Git at the agent's worktree. Selecting a project header points them at the project root. Terminal loses its targets list. |
| Project start page | Selecting a project header with the Agents tab active opens a composer for starting a quick agent or waking a durable one, plus a “Finished, waiting on you” list. This replaces Home and is treated as an experiment. |
| Home | Removed, together with `showHome`. |
| Canvas | Two canvases, unchanged: the app canvas (the sidebar's Canvas button) and the per-project canvas (the Canvas tab). No data migration. |
| Hosts (Annex) | Host switcher pill: a 28px row at the top of the sidebar. The menu shows connection state, Retry, “Pair a satellite…” and Annex settings. No default shortcut. |
| Settings | Swaps the sidebar to its categories. Projects are listed under the app categories, as today. The project header menu and the start page link straight to the project's settings. |
| First run | With no projects, the sidebar shows search and “Add project”, and the pane asks for a folder (or a dropped folder). |
| Shortcuts | ⌘1–9 select title-bar tabs (⌘1 is Agents). ⌥⌘1–9 switch agents in sidebar order. The “switch to project N” and “Go to Home” shortcuts are retired. Hosts get no default shortcut. ⌘B, ⌘K and ⌘, stay. |
| Sidebar width | Resizable, minimum 220px, default 264px. ⌘B collapses it to zero. |
| Platforms | macOS: traffic lights, unchanged. Windows: keeps `titleBarOverlay` (138px on the right). Linux: switches to `titleBarOverlay` too, which removes today's double title bar (75px down to 38px). Outside macOS, shortcuts display as Ctrl. |
| Popouts | Bare title bar: the title and the platform's window controls. |
| Plugins | v1 maps `railItem`, `tab` and `sidebar-content` through a compatibility layer. Native contribution points come in #1934. |
| Rollout | Behind an experimental flag, then stable soon after, then the default quickly, then a short, bounded period of dual support |

## 3. Prerequisites

Status as of 2026-10-16:
- Hub has been removed (#1915).
- Assistant, Agent Queue and Sessions have been removed (#1930).
- Structured mode removal is still open as #1937 (`chore/remove-structured-mode`). Until it merges, do not edit:
  - `features/agents/AddAgentDialog.tsx`, `AgentSettingsView.tsx`, `TemplateConfigDialog.tsx`, `AgentList.tsx` and `orchestrator-options.ts`
  - `features/settings/ExperimentalSettingsView.tsx`
  - `panels/MainContentView.tsx`
  - `e2e/start-agent.spec.ts`
- The telemetry renderer foundation is a hard dependency of chrome Phase 1. That is the facade, `telemetry:emit`, `AppErrorBoundary`, long-frame collection and the swallowed-catch lint. It ships in **telemetry Phase 3**, not Phase 1. Chrome Phase 1 does not start until telemetry Phase 3 is on main, because Phase 3 provides the `legacy` baseline the redesign is measured against (telemetry spec §9.1).
- #1898 (rail activity dots and an Active-first view) is also open. It edits `ProjectRail.tsx`, `ExplorerRail.tsx`, `SatelliteSection.tsx` and `uiStore.ts`, and adds `utils/projectActivity.ts`. Its UI targets the legacy rail, and the new shell does not carry it over: its indicator and view menu are superseded by the project tree's roll-ups and its pinned/recent/idle order. Its idea of “active” (agents running now) differs from the idle rule here (any activity in the last N days). If #1898 merges first, Phase 4 reuses its `projectActivity.ts` and adds the idle-window function beside it under a distinct name, rather than adding a second module. Whether #1898 still merges, given it would only live in the legacy shell during dual support, is the maintainer's call.

## 4. Architecture

### 4.1 Flag and shell

- Add an experimental flag `newChrome` (stored with `ExperimentalSettings` in `src/shared/types.ts`).
- `App.tsx` picks one of two shells:
  - `LegacyShell`: today's `TitleBar` + `RailSection` + `ProjectPanelLayout`, unchanged.
  - `ChromeShell`: new, `src/renderer/chrome/ChromeShell.tsx`.
- Banners, dialogs, the command palette and toasts stay shared outside both shells.
- Views inside the pane (sleeping, headless, finished quick agent, settings pages and the like) are restyled in both shells. Only the frame and layout (title bar, sidebar, where things live) are gated on the flag.
- The main process also reads the flag at window creation for the Linux overlay (§4.7). On Linux, toggling the flag requires a restart, and the settings toggle says so.

### 4.2 New modules (`src/renderer/chrome/`)

| Module | Responsibility |
|---|---|
| `ChromeShell.tsx` | The grid: sidebar, resize divider, pane. Applies `sidebarWidth` and `sidebarCollapsed`. |
| `titlebar/TitleBar.tsx` | Drag region, sidebar toggle, tabs, breadcrumb, and padding for the platform window controls. Replaces the old `TitleBar` in the new shell. |
| `titlebar/TabStrip.tsx` | Title-bar tabs for the active project, plus the More menu. Measures widths with a `ResizeObserver`. |
| `titlebar/overflow.ts` | Pure function `(tabs, widths, budget, activeId, mru) => { shown, overflow }`. Fills from the left. The active tab is always shown. The overflow list is ordered by most recent use. |
| `sidebar/Sidebar.tsx` | Composes the sidebar sections. Switches the body between the agent tree, a plugin list, and Settings. |
| `sidebar/HostSwitcher.tsx` | The host pill and its menu. Reuses `SatelliteSection` logic. |
| `sidebar/AppRow.tsx` | The Canvas and Review buttons, plus an overflow menu for every other top-position `railItem`, such as Goobers (§6). |
| `sidebar/NeedsYou.tsx` | The full section, or the 30px strip variant used in list mode. |
| `sidebar/ProjectTree.tsx` | Pinned, recent and idle grouping. Collapse and collapse-all. Project drag-reorder (reuses `projectStore.reorderProjects`). |
| `sidebar/ProjectGroup.tsx` | Project header (hover handle, pin, new agent, menu), agent rows, the sleeping fold, and quick-agent rows. |
| `sidebar/AgentRow.tsx` | The 30px row. Keeps today's context-menu actions from `AgentListItem.tsx`. |
| `sidebar/AgentHoverCard.tsx` | Status and duration, current detail, orchestrator and model, branch, worktree, MCP servers, Free Agent Mode, last session. Actions: Open terminal, Stop or Wake, Settings. |
| `sidebar/FinishedQuickAgents.tsx` | The fold row, per-item Dismiss and Clear all. Backed by `quickAgentStore.dismissCompleted` / `clearCompleted`. |
| `sidebar/ListBody.tsx` | Hosts a plugin's `SidebarPanel` (the `sidebar-content` layout) or the settings navigation, with a breadcrumb. Owns ⌘1 to return to Agents. |
| `sidebar/SettingsNav.tsx` | App categories, then a Projects section with each project's categories. Replaces `SettingsCategoryNav` and `SettingsContextPicker` in the new shell. |
| `pages/ProjectStartPage.tsx` | The composer (quick or durable, orchestrator and model, base branch, Start) and the “Finished, waiting on you” list. The list is owned by main (`finished-quick-agents.json`, #2467) so Annex can share it with a phone (docs/mobile-control-v1.md, Finished quick agents); `quick_completed_<projectId>` in localStorage is the startup copy and the one-time migration source. |
| `pages/FirstRun.tsx` | The no-projects state. |
| `chromeStore.ts` | Selection (`{kind: 'agent', id} \| {kind: 'project', id}`), sidebar width and collapsed state, per-project collapsed state, pins, the idle window, the tab MRU per project, and the sleeping/finished fold state. Persisted under `clubhouse_chrome_v2`. |
| `selectors/needsAttention.ts` | Blocked agents across the local host and every connected satellite (`annexClientStore` / `remoteProjectStore`). |
| `selectors/projectActivity.ts` | Last-activity timestamp per project for the idle rule, from agent run/wake events, quick-agent starts and tab opens. |

### 4.3 Existing files that change

| File | Change |
|---|---|
| `src/renderer/App.tsx` | Picks the shell. The project-switch telemetry span moves to the selection path (§8). |
| `src/renderer/features/agents/AgentAvatar.tsx` | New `2xs` size (18px). The orchestrator glyph becomes neutral. |
| `src/renderer/features/agents/AgentListItem.tsx` | Context-menu actions move into a shared hook used by both rows. The legacy row is otherwise unchanged. |
| `src/renderer/stores/uiStore.ts` | `projectExplorerTab` stays the source of the last tab per project. `explorerTab` values map to title-bar tabs. `showHome` is ignored in the new shell. |
| `src/renderer/stores/keyboardShortcutsStore.ts` | Definitions and defaults become per shell, so `buildShortcuts(definitions, overrides)` takes the active shell's set. The new shell's overrides live under `clubhouse_chrome_v2` (§5.3). |
| `src/renderer/features/command-palette/` | Adds commands for projects, agents, hosts and tabs. The palette replaces “switch to project N”. |
| `src/renderer/plugins/builtin/terminal` | In the new shell, follows the scope from `chromeStore`. The targets list is hidden. |
| `src/renderer/plugins/builtin/files` (`FileTree.ts`) | Root follows the scope. The worktree selector is hidden in the new shell. |
| `src/renderer/plugins/builtin/git` | Follows the scope. |
| `src/renderer/plugins/builtin/review` | New entry point from “Needs you”, with Needs Attention Only preset. |
| `src/renderer/panels/SatelliteSection.tsx` | Host rows become `HostSwitcher` menu items. Retry moves into the menu. |
| `src/renderer/features/popout/` | Bare title bar with platform padding. |
| `src/main/index.ts`, `src/main/ipc/window-handlers.ts` | Linux: `titleBarStyle: 'hidden'` + `titleBarOverlay` when `newChrome` is on. |
| `src/renderer/index.css` | Overlay padding on Linux as well as Windows. Theme tokens for any new surfaces. |
| `src/renderer/features/agents/QuickAgentDialog.tsx` | ⌘⇧N opens the start page composer for the selected project. The dialog remains in the legacy shell. |

### 4.4 Removed when the legacy shell is removed (§10, last stage)

- `panels/ProjectRail.tsx`, `panels/ExplorerRail.tsx`, `components/RailSection.tsx`, and the explorer half of `components/ProjectPanelLayout.tsx`.
- `features/projects/Dashboard.tsx` and the rail pin.
- The `showHome` setting. While both shells exist, the Home row in `features/settings/DisplaySettingsView.tsx:8` is hidden when the new shell is active and still shown in the legacy shell. Both the row and `uiStore.showHome` are deleted with the legacy shell.
- The legacy shortcut set (`go-home`, `switch-project-*`, `toggle-accessory`) and the legacy overrides key `clubhouse_keyboard_shortcut_overrides`, after its still-valid entries have been carried into the new shell's overrides.
- The legacy `AgentList` / `AgentListItem` views, once the row actions hook is the only consumer.

### 4.5 Scope model

- `chromeStore.selection` is the single source of scope. Selecting an agent row sets `{kind:'agent'}`, and selecting a project header sets `{kind:'project'}`.
- The scope resolves to `{projectId, cwd, branch, label}`:
  - Agent scope uses the agent's `worktreePath`, falling back to the project root for agents without a worktree. The tab then says so.
  - Project scope uses the project path and its current branch.
- Terminal, Files and Git subscribe to the resolved scope. A Terminal session is keyed by scope, so switching selection switches terminals without killing them, matching today's per-target sessions.
- Files and Git show a scope line above their list (name plus “worktree” or “root”).

### 4.6 Lists and Settings in the sidebar

- When the active tab's manifest layout is `sidebar-content`, `ListBody` renders the plugin's `SidebarPanel` in place of the tree. The host pill and the “Needs you” strip stay on top.
- Settings uses the same mechanism (⌘, opens it), so the agent tree is hidden while Settings is open, as it is today.
- ⌘1, the breadcrumb, or Esc returns to Agents.

### 4.7 Platform chrome

- macOS: `hiddenInset` stays.
- Windows: the overlay stays, and the right padding stays at 138px.
- Linux, under the flag: `titleBarStyle: 'hidden'` with `titleBarOverlay {color, symbolColor, height: 38}`, matching Windows. The title bar adds the `.win-overlay-padding` equivalent on Linux.
- Verify the overlay on GNOME (Wayland and X11) and KDE. Electron's Linux overlay support varies by desktop. If a desktop renders no controls, fall back to the native frame for that session and log it to telemetry.
- The title bar keeps at least 80px of draggable empty space between the tabs and the breadcrumb at every width. The tab budget is computed after reserving it.

### 4.8 Accessibility

- The project tree uses `role="tree"` with `treeitem` rows: roving tabindex, arrow keys to move, Left/Right to collapse and expand, Enter to open, and Shift+F10 or the context-menu key for the row menu.
- The hover card also opens on keyboard focus after a delay and closes on Esc.
- Title-bar tabs use `role="tablist"`, and the More menu is a menu button.
- Drag-reorder has keyboard equivalents in the project menu (Move up / Move down) and in the agent row menu.

## 5. Data and migrations

All new state lives under new keys. The legacy shell keeps reading its own keys untouched, so turning the flag off restores the old layout exactly.

### 5.1 Panel sizes (`clubhouse_panel_sizes` → `clubhouse_chrome_v2`)

- `sidebarWidth` defaults to 264. Nothing is carried over from `explorerWidth` or `accessoryWidth`, because the columns are not comparable.
- `sidebarCollapsed` defaults to false.
- `railPinned` and `railWidth` are ignored by the new shell. The legacy keys are deleted when the legacy shell is removed.

### 5.2 View preferences (`clubhouse_view_prefs`)

- `projectExplorerTab[projectId]` is reused as the last tab per project. `agents` maps to the Agents tab. Values for plugins that no longer exist fall back to Agents (the #1915 pattern).
- `showHome` is ignored by the new shell, and its Display setting row is hidden there (§4.4). It is removed with the legacy shell. With `activeProjectId === null` and at least one project, startup opens the most recently active project's Agents tab instead of Home.

### 5.3 Keyboard shortcuts

The legacy key `clubhouse_keyboard_shortcut_overrides` is a flat `Record<string, string>` (`keyboardShortcutsStore.ts:11`). It has no room for a version marker, and the legacy shell and older app versions both read it. It stays untouched while the legacy shell exists, so turning the flag off, or downgrading, restores the user's bindings exactly.

- **Per-shell definitions.** `buildShortcuts` is global today. It becomes `buildShortcuts(definitions, overrides)`, and the active shell supplies both arguments. The Keyboard Shortcuts settings page edits the active shell's set.
- **Legacy set (unchanged).** `switch-agent-N` = `Meta+N`, `switch-project-N` = `Meta+Alt+N`, `go-home` = `Meta+Shift+H`, `toggle-accessory` = `Meta+Shift+B`, plus the shared actions below.
- **New-shell set:**
  - `tab-1`…`tab-9` = `Meta+1…9`. `tab-1` is Agents.
  - `switch-agent-1…9` = `Meta+Alt+1…9`, in sidebar order. Note that `Meta+Alt+N` means switch to project N in the legacy shell and switch to agent N in the new one.
  - `go-home`, `switch-project-*` and `toggle-accessory` are not defined, because there is no Home and no accessory column.
  - Shared actions keep their ids and defaults: `command-palette` (`Meta+K`), `toggle-settings` (`Meta+,`), `toggle-help` (`Meta+Shift+/`, opens Help in the pane), `toggle-sidebar` (`Meta+B`, collapses the sidebar), `new-quick-agent` (`Meta+Shift+N`, opens the start page composer), `focus-active-terminal` (`Meta+Shift+T`), `add-project` (`Meta+Shift+O`) and `close-project` (`Meta+Shift+W`).
- **New-shell storage.** Overrides are stored in `clubhouse_chrome_v2` as `shortcuts: {version, overrides}`.
- **Seeding.** The first time the new shell runs, it copies legacy overrides for ids that exist in both sets with the same meaning: the shared actions and `switch-agent-N`. It never copies retired ids. It never writes to the legacy key.
- **Collisions.** If a seeded or user override collides with a new-shell default, the user's binding wins, the default action stays unbound, and Settings shows the conflict.
- **Removal.** Retired ids leave the legacy key only when the legacy shell is removed (§4.4).
- **Tests.** Unit-tested for: no overrides; legacy overrides of retired ids, which are not seeded and stay intact in the legacy key; colliding overrides; and a flag-off round trip, where the legacy bindings are unchanged.

### 5.4 Project order, pins and idle

- Order stays in `projects.json`, through the existing `reorderProjects`.
- Pins, the per-project collapsed state, and the idle window (default 7 days) live in `clubhouse_chrome_v2`.
- Activity timestamps are derived at runtime from agent and quick-agent events and from tab opens. They are cached in `clubhouse_chrome_v2`, so idle state survives a restart.
- Pins, inactive marks, activity and the idle window are owned by main (`project-state.json`, #2458), so Annex can sync them with a phone (docs/mobile-control-v1.md, Project state). The sidebar applies each change at once and sends it to main; `clubhouse_chrome_v2` keeps a copy for startup, and is what the first window hands to main, once, as the migration.

### 5.5 Not migrated

The canvas (both canvases are unchanged), agent configs, and the persisted state of quick agents.

## 6. Plugin compatibility

v1 needs no plugin changes. The mapping:

| Manifest | Legacy shell | New shell |
|---|---|---|
| `tab` with `layout: 'sidebar-content'` (default) | Explorer entry plus accessory column | Title-bar tab. Its `SidebarPanel` swaps into the sidebar body. |
| `tab` with `layout: 'full'` | Explorer entry, full-width content | Title-bar tab. The agent tree stays in the sidebar. |
| `tab.title` / `railItem.title` | Window title | Breadcrumb text |
| `railItem` (`position: 'top'`) | Rail button | Canvas and Review get the two inline app-row buttons. Every other top item goes in the app-row overflow menu. Today that is Goobers (`builtin/goobers/manifest.ts:18`) and any external plugin with a top rail item. |
| `railItem` (`position: 'bottom'`) | Rail bottom | Footer icon with a tooltip |
| Badges (`badgeStore`) | Rail and tab badges | Tab label count, project header roll-up, app row count |
| Annex gating (`annexEnabled`) | Dimmed rail and tab items | Same rule, applied to the title-bar tab and the app row |

Canvas and Review declare both a `railItem` and a `tab`, so they appear twice, at two scopes. That is intended. The `railItem` is the app-level view, which the app row opens: the cross-project canvas, and Review across all projects. The `tab` is the project-level view, a title-bar tab for the current project. The Review tab follows today's per-project plugin enablement, so it only shows in projects where Review is enabled.

Third-party plugins cannot read the new scope in v1. Built-ins read `chromeStore` directly. A scope API, native title-bar and sidebar contribution points, and a deprecation timeline for the old fields are tracked in #1934.

Before Phase 1 ships, add a plugin-author note to the docs, and verify the installed external plugins that contribute `railItem` or `tab` (three and four respectively at last count) plus the ten theme plugins against the new surfaces.

## 7. Phases

Each phase lands behind `newChrome` and keeps the legacy shell working. Sizes follow the telemetry spec's convention (S/M/L).

### Phase 1: shell, sidebar and rows (L, two PRs)

Depends on telemetry Phase 3 being on main (§3).

- 1a:
  - `ChromeShell`, the flag, `chromeStore` (width, collapsed, selection), and the resize divider (220px minimum).
  - ⌘B collapse.
  - The title bar with a tab strip, no overflow yet, using today's tabs per project.
  - The breadcrumb, with platform padding on macOS and Windows.
- 1b:
  - `ProjectTree`, `ProjectGroup` and `AgentRow` (30px).
  - Collapse and collapse-all, project drag-reorder, pins.
  - The sleeping fold, finished quick agents with Dismiss and Clear all, quick-agent rows.
  - The footer, and the `AppRow` with Canvas and Review.
  - `NeedsYou`, local host only.
- Exit: a user can do everything the legacy shell does for local projects, apart from list tabs, which still render in a temporary second column.

### Phase 2: lists, scope, Settings, start page (L, two PRs)

- 2a:
  - `ListBody` swapping for `sidebar-content` tabs.
  - The “Needs you” strip.
  - The scope model wired into Terminal (targets list hidden), Files (root follows scope) and Git.
  - `SettingsNav`, with projects listed in Settings.
- 2b: `ProjectStartPage` (composer plus finished work), `FirstRun`, and the ⌘⇧N repoint.
- Exit: there is no second column anywhere, and Home is unreachable in the new shell.

### Phase 3: hosts, overflow, platforms, shortcuts (M)

- `HostSwitcher`, and a cross-host `needsAttention` selector with host tags. A remote click switches host and opens the agent.
- `overflow.ts` and the More menu, with MRU and the active tab pinned.
- Breadcrumb shortening below 1100px.
- The Linux overlay in the main process.
- The shortcut defaults and the override migration.
- The bare title bar for popouts.

### Phase 4: details and polish (M)

- `AgentHoverCard`, and the shared row-actions hook for the right-click menu.
- The idle rule (`projectActivity`) and the idle row.
- Keyboard and ARIA pass (§4.8). Theme token review across installed themes.
- Command palette additions.

### Phase 5: stabilize and flip (S–M)

- Complete the telemetry parity (§8) and E2E (§9) checklists.
- Run both shells in CI.
- Graduate the flag through the stages in §10.

Phases 1–4 run in order. Phase 4 can start as soon as 2a lands. It touches different files apart from `AgentRow`.

## 8. Telemetry checklist

Per [telemetry spec §9.1](telemetry-otel-spec.md), the redesign owns the UI-coupled instrumentation. It is built on the telemetry facade and the typed attribute registry.

Owned call sites:
- `c.view` stays the coarse, bounded enum from the telemetry spec (§4.15: `agent`/`terminal`/`canvas`/`files`/`git`/`settings`/`plugin`/`other`). The new shell sets it from the active title-bar tab and pane. Every non-built-in tab maps to `plugin`, and the start page and first run map to `other`. No new `c.view` values are added.
- Where in the new chrome the user is goes in a separate bounded attribute, `c.ui.surface`: `sidebar_agents`, `sidebar_list`, `sidebar_settings`, `sidebar_help`, `sidebar_agent_settings`, `start_page`, `first_run`, `host_menu`, `more_menu`, `hover_card`, `row_menu`. Plugin-owned lists all report `sidebar_list`, and plugin ids are never used as values, which keeps the long-frame and render-error metrics well under the cap of 200 attribute sets per instrument (telemetry spec, metric export settings). It goes on slow-frame and render-error signals beside `c.view`.
- The project-switch span, moved out of the `App.tsx` effect into the selection path. It also fires when a remote “Needs you” click switches host.
- File open and save spans in the Files viewer under the new scope.
- Command-palette and feature-usage events:
  - the Canvas and Review row
  - a “Needs you” click (local or remote)
  - host switch
  - More menu open and pick
  - collapse, collapse-all, pin and reorder
  - start page Start
  - Dismiss and Clear all
  - hover card actions
- `c.ui.action_failed` at every new catch site. The lint rule enforces this.
- A new **resource (session) attribute** `c.ui.chrome` = `legacy` | `v2`, set once at startup from the flag. Gate item 5 compares session-level metrics (crash-free sessions, startup p95), so the attribute has to sit on every item in the session, not only on UI events. Switching the layout therefore takes effect on the next launch, and the settings toggle says so. One session never mixes the two shells.

Must pass before the flag goes stable:
1. Every span, metric and event the legacy shell emits has a named equivalent in the new shell, or is retired in the registry with a reason.
2. Every Clubhouse Workbook panel that charted an old signal still has data.
3. New `c.ui.surface` and `c.ui.action_failed` values, and the `c.ui.chrome` resource attribute, are added to `src/shared/telemetry/attributes.ts` in the same PR as the code, with telemetry review via CODEOWNERS.
4. P0 regression signals keep their level and alert rules.
5. Crash-free rate, startup p95 and slow frames under `v2` are no worse than the `legacy` baseline over the same window.

## 9. Test checklist

Unit tests (vitest), plus `npm run typecheck` and lint, since vitest does not typecheck:
- `overflow.ts`: budgets, MRU ordering, the active tab always shown, narrow widths.
- `chromeStore` persistence and defaults.
- Selection and scope resolution, including agents without worktrees.
- The idle rule, including sleeping agents and pinned projects.
- The `needsAttention` selector across hosts.
- Per-shell shortcut definitions and seeding, including the flag-off round trip (§5.3).
- `projectExplorerTab` fallback.
- `FinishedQuickAgents` Dismiss and Clear all.
- `ListBody` swapping for `sidebar-content` versus `full` tabs.

E2E (Playwright/Electron). Run in CI only, not locally.

To keep churn down, the new shell **keeps today's test IDs wherever the element has the same meaning**:

| Test ID | Element in the new shell |
|---|---|
| `nav-add-project` | Add project in the sidebar, also shown during first run (the first-run pane's own button is `first-run-choose`) |
| `nav-settings`, `nav-help` | Footer Settings and Help |
| `title-bar` | Title bar root |
| `agent-item-<agentId>` | Sidebar agent row (not a new `agent-row-*` id) |
| `project-<projectId>` | Project header |
| `explorer-tab-<tabId>` | Title-bar tab, including `explorer-tab-agents` and `explorer-tab-plugin:<id>` |
| `agent-list` | The agent tree inside the sidebar |
| `resize-divider` | Sidebar resize handle |

Three IDs have no equivalent and are legacy-only: `nav-home`, `rail-pin-button` and `rail-container`.

Twenty-five E2E files use the old IDs, counting helpers and fixtures. All of them have to run under both shells, and any that use the legacy-only IDs need a branch for the new shell:

- Shared helpers and fixtures: `smoke-helpers.ts`, `annex-v2/helpers.ts`, `fixtures/project-smoke/index.ts`.
- Specs:
  - `agent-list-ui`, `agent-real-cli`, `annex-v2/full-demo`
  - `canvas-create`, `canvas-golden-path`, `canvas-group-project-create`
  - `command-palette`, `find-replace`, `navigation`, `open-project`, `plugin-system`, `popout-window`, `project-switching`
  - `rail-hover-flyout`, `rail-pin`
  - `smoke-agent-lifecycle`, `smoke-blank-screen`, `smoke-settings-persistence`
  - `start-agent` (also edited by #1937, so rebase onto it)
  - `terminal-e2e`, `terminal`

- During dual support, these run against both shells through a fixture that sets `newChrome`.
- `rail-hover-flyout` and `rail-pin` are legacy-only and get deleted with the legacy shell.
- Add new specs for:
  - the sidebar tree (collapse, pin, reorder)
  - list swapping and the breadcrumb
  - scope switching for Terminal, Files and Git
  - “Needs you”, including a dual-instance Annex spec for remote rows
  - the More menu
  - the start page
  - first run
  - Settings navigation
- Test IDs for new elements only, as a contract (existing IDs above are kept):
  - `chrome-sidebar`
  - `host-switcher`, `host-menu`
  - `app-row-canvas`, `app-row-review`
  - `needs-you`, `needs-you-row-<agentId>`
  - `project-group-<projectId>` (the header keeps `project-<projectId>`), `project-collapse-all`, `idle-projects`
  - `agent-hover-card`
  - `finished-quick-<projectId>`, `sleeping-fold-<projectId>`
  - `title-more` (tabs keep `explorer-tab-<tabId>`)
  - `list-breadcrumb`, `settings-nav`, `start-page`, `first-run`, `first-run-choose`
- Known flake: the canvas golden-path right-click spec on macOS and Windows CI. Re-run before investigating.
- Manual QA on real hardware for anything drag-related (project and agent reorder, tab pinning out of the More menu). Synthetic input does not reproduce native macOS drag behavior.
- Linux overlay manual QA on GNOME (Wayland and X11) and KDE.

## 10. Rollout

| Stage | What changes | Exit criteria |
|---|---|---|
| Experimental | `newChrome` off by default, toggled in Settings → Experimental | Phases 1–3 landed. Maintainer dogfoods daily. No P0 or P1 bugs open. |
| Stable, opt-in | Flag graduates to a regular setting (“Use the new layout”), still off by default. Preview channel defaults it on. | Phase 4 landed. Telemetry checklist items 1–4 pass. E2E green on both shells on all three OSes. |
| Default | On for everyone, with “Use classic layout” in Settings | Checklist item 5 passes over at least one release on the preview channel. The plugin-author note is published. |
| Dual support | Classic layout still available but frozen (no new features) | Bounded to two stable releases after Default. |
| Legacy removal | Delete the §4.4 files and the legacy keys (§5). Remove the setting. | No blocking issues filed against the new shell during dual support. |

The plan is to move through Experimental and Stable quickly, so dual support stays short but not abrupt.

## 11. Risks and open items

- Electron's `titleBarOverlay` on Linux differs by desktop environment. The fallback in §4.7 covers it, but QA has to confirm it on each desktop.
- Draggable title-bar space shrinks as tabs are added. The 80px reserve in §4.7 is a starting value that needs checking on Windows, where the controls take 138px.
- The start page is an experiment. Its feature-usage events (§8) decide whether it stays. If the composer and finished list see little use, the fallback is to remove the page and put “New agent” on project header hover.
- Terminal sessions keyed by scope need a cap and a clean-up policy, so sessions for agents nobody selects again don't accumulate.
- Annex: the remote “Needs you” rows depend on satellites streaming their attention state. Confirm that the satellite snapshot already includes `agentDetailedStatus`, or extend the protocol, which is negotiated with Annex V2.
- Performance: the tree re-renders on every agent status change. Rows need memoization by agent id, and roll-ups need memoized selectors. Slow-frame telemetry under `c.ui.chrome=v2` is the check.
