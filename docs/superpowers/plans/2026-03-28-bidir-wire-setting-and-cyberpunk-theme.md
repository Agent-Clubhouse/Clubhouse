# Create-Bidirectional-Wires Setting & Cyberpunk Theme Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `create-bidirectional-wires` canvas setting that controls whether agent-to-agent wires auto-create the reverse direction, and add a "Cyberpunk" builtin theme with 80s neon aesthetics.

**Architecture:** The setting threads through manifest → main.ts plugin host → CanvasWorkspace prop → useWiring hook parameter. The theme follows the existing builtin pattern: type definition, theme file, registry entry.

**Tech Stack:** React, Zustand, TypeScript, Vitest

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/renderer/plugins/builtin/canvas/manifest.ts` | Modify | Add setting definition |
| `src/renderer/plugins/builtin/canvas/manifest.test.ts` | Modify | Test setting exists |
| `src/renderer/plugins/builtin/canvas/useWiring.ts` | Modify | Accept + use `createBidirectional` param |
| `src/renderer/plugins/builtin/canvas/main.ts` | Modify | Read setting, pass as prop |
| `src/renderer/plugins/builtin/canvas/CanvasWorkspace.tsx` | Modify | Accept prop, pass to useWiring |
| `src/shared/types.ts` | Modify | Add `'cyberpunk'` to BuiltinThemeId |
| `src/renderer/themes/cyberpunk.ts` | Create | Theme definition |
| `src/renderer/themes/index.ts` | Modify | Import + register theme |

---

### Task 1: Add `create-bidirectional-wires` manifest setting

**Files:**
- Modify: `src/renderer/plugins/builtin/canvas/manifest.ts:29-44`
- Modify: `src/renderer/plugins/builtin/canvas/manifest.test.ts:72-77`

- [ ] **Step 1: Write the failing test**

In `manifest.test.ts`, add after the existing `bidirectional-wires` test (after line 77):

```typescript
it('contributes create-bidirectional-wires boolean setting with default true', () => {
  const setting = manifest.contributes!.settings!.find((s) => s.key === 'create-bidirectional-wires');
  expect(setting).toBeDefined();
  expect(setting!.type).toBe('boolean');
  expect(setting!.default).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/plugins/builtin/canvas/manifest.test.ts`
Expected: FAIL — setting not found, `setting` is `undefined`

- [ ] **Step 3: Add the setting to manifest.ts**

In `manifest.ts`, add a new entry to the `settings` array after the `bidirectional-wires` entry (after line 43):

```typescript
{
  key: 'create-bidirectional-wires',
  type: 'boolean',
  label: 'Create Bidirectional Wires',
  description: 'When wiring two agents, automatically create the reverse direction as well.',
  default: true,
},
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/plugins/builtin/canvas/manifest.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/plugins/builtin/canvas/manifest.ts src/renderer/plugins/builtin/canvas/manifest.test.ts
git commit -m "feat(canvas): add create-bidirectional-wires setting to manifest"
```

---

### Task 2: Thread the setting through useWiring

**Files:**
- Modify: `src/renderer/plugins/builtin/canvas/useWiring.ts:74-81,180-192`

- [ ] **Step 1: Add `createBidirectional` parameter to useWiring**

In `useWiring.ts`, add a new parameter after `onAddWireDefinition` (line 81):

```typescript
export function useWiring(
  views: CanvasView[],
  viewport: Viewport,
  containerRef: React.RefObject<HTMLDivElement | null>,
  onZoneWire?: ZoneWireCallback,
  /** Callback to persist a wire definition in the canvas store. */
  onAddWireDefinition?: (entry: { agentId: string; targetId: string; targetKind: string; label: string; agentName?: string; targetName?: string; projectName?: string }) => void,
  /** When true (default), agent-to-agent wires auto-create the reverse direction. */
  createBidirectional = true,
) {
```

- [ ] **Step 2: Gate the reverse binding block with `createBidirectional`**

In `useWiring.ts`, wrap the existing reverse-bind block (lines 180-192) with the setting check. Replace:

```typescript
          // Agent-to-agent wires default to bidirectional
          if (kind === 'agent') {
```

with:

```typescript
          // Agent-to-agent wires: optionally create reverse direction
          if (kind === 'agent' && createBidirectional) {
```

- [ ] **Step 3: Add `createBidirectional` to the useEffect dependency array**

In `useWiring.ts`, the `useEffect` dependency array (line 213) currently has `[wireDrag, containerRef, bind]`. Add `createBidirectional`:

```typescript
  }, [wireDrag, containerRef, bind, createBidirectional]);
```

- [ ] **Step 4: Run existing tests to verify no regressions**

Run: `npx vitest run src/renderer/plugins/builtin/canvas/`
Expected: All existing tests PASS (default `true` preserves behavior)

- [ ] **Step 5: Commit**

```bash
git add src/renderer/plugins/builtin/canvas/useWiring.ts
git commit -m "feat(canvas): gate reverse wire creation on createBidirectional param"
```

---

### Task 3: Read the setting in main.ts and pass through CanvasWorkspace

**Files:**
- Modify: `src/renderer/plugins/builtin/canvas/main.ts:132-135,506`
- Modify: `src/renderer/plugins/builtin/canvas/CanvasWorkspace.tsx:67-79,111,175`

- [ ] **Step 1: Read the setting in main.ts**

In `main.ts`, after the existing `bidirectionalWires` read (around line 135), add:

```typescript
const createBidirectionalWires = usePluginStore(
  (s) => (s.pluginSettings[settingsKey]?.['create-bidirectional-wires'] as boolean) ?? true,
);
```

Note the default is `?? true` (matches manifest default).

- [ ] **Step 2: Pass it as a prop to CanvasWorkspace**

In `main.ts`, in the `React.createElement(CanvasWorkspace, { ... })` block (around line 506), add the new prop alongside `bidirectionalWires`:

```typescript
createBidirectionalWires,
```

- [ ] **Step 3: Add the prop to CanvasWorkspaceProps**

In `CanvasWorkspace.tsx`, add to the `CanvasWorkspaceProps` interface (after line 79):

```typescript
/** When true, auto-create reverse direction for agent-to-agent wires. */
createBidirectionalWires?: boolean;
```

- [ ] **Step 4: Destructure the prop in CanvasWorkspace**

In `CanvasWorkspace.tsx`, add `createBidirectionalWires` to the destructured props (after `bidirectionalWires` on line 111):

```typescript
createBidirectionalWires,
```

- [ ] **Step 5: Pass it to useWiring**

In `CanvasWorkspace.tsx`, update the `useWiring` call (line 175) to pass the new parameter:

```typescript
const { wireDrag, startWireDrag, isWireDragging } = useWiring(views, viewport, containerRef, handleZoneWire, handleAddWireDef, createBidirectionalWires);
```

- [ ] **Step 6: Run tests to verify no regressions**

Run: `npx vitest run src/renderer/plugins/builtin/canvas/`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
git add src/renderer/plugins/builtin/canvas/main.ts src/renderer/plugins/builtin/canvas/CanvasWorkspace.tsx
git commit -m "feat(canvas): thread create-bidirectional-wires setting to useWiring"
```

---

### Task 4: Add `cyberpunk` to BuiltinThemeId

**Files:**
- Modify: `src/shared/types.ts:695-703`

- [ ] **Step 1: Add `'cyberpunk'` to the BuiltinThemeId union**

In `src/shared/types.ts`, add `'cyberpunk'` to the union (after `'gruvbox-dark'` on line 703):

```typescript
export type BuiltinThemeId =
  | 'catppuccin-mocha'
  | 'catppuccin-latte'
  | 'solarized-dark'
  | 'terminal'
  | 'nord'
  | 'dracula'
  | 'tokyo-night'
  | 'gruvbox-dark'
  | 'cyberpunk';
```

- [ ] **Step 2: Commit**

```bash
git add src/shared/types.ts
git commit -m "feat(themes): add cyberpunk to BuiltinThemeId"
```

---

### Task 5: Create the Cyberpunk theme definition

**Files:**
- Create: `src/renderer/themes/cyberpunk.ts`

- [ ] **Step 1: Create the theme file**

Create `src/renderer/themes/cyberpunk.ts`:

```typescript
import { ThemeDefinition } from '../../shared/types';

export const cyberpunk: ThemeDefinition = {
  id: 'cyberpunk',
  name: 'Cyberpunk',
  type: 'dark',
  fontOverride: "'Orbitron', 'Share Tech Mono', 'SF Mono', 'Fira Code', monospace",
  colors: {
    base: '#0d0221',
    mantle: '#080118',
    crust: '#050010',
    text: '#e0f0ff',
    subtext0: '#8a9bb5',
    subtext1: '#a8b8d0',
    surface0: '#1a0a3e',
    surface1: '#241452',
    surface2: '#2e1e66',
    accent: '#ff2d95',
    link: '#00e5ff',
    warning: '#ffe600',
    error: '#ff3366',
    info: '#00e5ff',
    success: '#39ff14',
  },
  hljs: {
    keyword: '#ff2d95',
    string: '#39ff14',
    number: '#ffe600',
    comment: '#6b5b95',
    function: '#00e5ff',
    type: '#ff6e27',
    variable: '#e0f0ff',
    regexp: '#ff2d95',
    tag: '#00e5ff',
    attribute: '#ff6e27',
    symbol: '#ffe600',
    meta: '#8a9bb5',
    addition: '#39ff14',
    deletion: '#ff3366',
    property: '#00e5ff',
    punctuation: '#6b5b95',
  },
  terminal: {
    background: '#0d0221',
    foreground: '#e0f0ff',
    cursor: '#ff2d95',
    cursorAccent: '#0d0221',
    selectionBackground: '#2e1e6666',
    selectionForeground: '#e0f0ff',
    black: '#1a0a3e',
    red: '#ff3366',
    green: '#39ff14',
    yellow: '#ffe600',
    blue: '#00e5ff',
    magenta: '#ff2d95',
    cyan: '#00ffff',
    white: '#a8b8d0',
    brightBlack: '#2e1e66',
    brightRed: '#ff6688',
    brightGreen: '#66ff44',
    brightYellow: '#ffee55',
    brightBlue: '#44eeff',
    brightMagenta: '#ff55aa',
    brightCyan: '#55ffff',
    brightWhite: '#e0f0ff',
  },
};
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/themes/cyberpunk.ts
git commit -m "feat(themes): add cyberpunk theme definition"
```

---

### Task 6: Register the Cyberpunk theme

**Files:**
- Modify: `src/renderer/themes/index.ts:1-21`

- [ ] **Step 1: Import the cyberpunk theme**

In `index.ts`, add the import after the `gruvbox-dark` import (after line 9):

```typescript
import { cyberpunk } from './cyberpunk';
```

- [ ] **Step 2: Add to BUILTIN_THEMES**

In `index.ts`, add to the `BUILTIN_THEMES` record after `'gruvbox-dark'` (after line 20):

```typescript
'cyberpunk': cyberpunk,
```

- [ ] **Step 3: Run build to verify no type errors**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Run all theme-related and canvas tests**

Run: `npx vitest run src/renderer/themes/ src/renderer/plugins/builtin/canvas/`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/themes/index.ts
git commit -m "feat(themes): register cyberpunk theme in builtin registry"
```
