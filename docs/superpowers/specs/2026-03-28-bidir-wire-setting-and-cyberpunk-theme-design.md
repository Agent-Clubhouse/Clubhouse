# Create-Bidirectional-Wires Setting & Cyberpunk Theme

Two additions to the canvas plugin and theme system.

---

## 1. `create-bidirectional-wires` Setting

### Problem

Agent-to-agent wires always create both directions (A->B and B->A) with no way to opt out. Users who want unidirectional agent-to-agent wires must manually disconnect the reverse direction after every drag.

### Design

**New canvas plugin setting:**

```ts
{
  key: 'create-bidirectional-wires',
  type: 'boolean',
  label: 'Create Bidirectional Wires',
  description: 'When wiring two agents, automatically create the reverse direction as well.',
  default: true,
}
```

- Added to `manifest.ts` settings array alongside the existing `bidirectional-wires` visual setting.
- Default `true` preserves current behavior (no breaking change).

**Implementation in `useWiring.ts`:**

The hook reads the setting value and conditionally skips the reverse `bind()` + `onAddWireDefinition()` calls at lines 181-192. When `false`, dragging A->B only creates the A->B binding.

**Scope:** Agent-to-agent wires only. Zone wires and browser/group-project/agent-queue targets are unaffected (they are already unidirectional).

**Passing the setting to the hook:**

`CanvasWorkspace.tsx` already reads canvas settings. It will read `create-bidirectional-wires` and pass it as a new parameter to `useWiring()`. The hook uses it to gate the reverse binding block.

### Files to modify

| File | Change |
|------|--------|
| `src/renderer/plugins/builtin/canvas/manifest.ts` | Add setting definition |
| `src/renderer/plugins/builtin/canvas/useWiring.ts` | Accept `createBidirectional` param, gate reverse bind |
| `src/renderer/plugins/builtin/canvas/CanvasWorkspace.tsx` | Read setting, pass to `useWiring` |
| `src/renderer/plugins/builtin/canvas/manifest.test.ts` | Test new setting exists |
| `src/renderer/plugins/builtin/canvas/main.test.ts` | Test wiring respects setting |

---

## 2. Cyberpunk "Neon" Theme

### Design Direction

80s retro-futuristic aesthetic. Deep void purple-black backgrounds with high-contrast neon accents across the full spectrum: hot pink, cyan, green, yellow, orange. Geometric/futuristic font override.

### Color Palette

#### `colors` (semantic UI)

| Token | Hex | Purpose |
|-------|-----|---------|
| base | `#0d0221` | Deep void purple-black background |
| mantle | `#080118` | Darker backing |
| crust | `#050010` | Deepest black |
| text | `#e0f0ff` | Cool white with blue tint |
| subtext0 | `#8a9bb5` | Muted steel blue |
| subtext1 | `#a8b8d0` | Lighter steel |
| surface0 | `#1a0a3e` | Dark purple panel |
| surface1 | `#241452` | Mid purple |
| surface2 | `#2e1e66` | Lighter purple |
| accent | `#ff2d95` | Hot pink (signature neon) |
| link | `#00e5ff` | Neon cyan |
| warning | `#ffe600` | Neon yellow |
| error | `#ff3366` | Neon red-pink |
| info | `#00e5ff` | Neon cyan |
| success | `#39ff14` | Neon green |

#### `hljs` (syntax highlighting)

| Token | Hex | Neon color |
|-------|-----|------------|
| keyword | `#ff2d95` | Hot pink |
| string | `#39ff14` | Neon green |
| number | `#ffe600` | Neon yellow |
| comment | `#6b5b95` | Muted purple |
| function | `#00e5ff` | Neon cyan |
| type | `#ff6e27` | Neon orange |
| variable | `#e0f0ff` | Cool white |
| regexp | `#ff2d95` | Hot pink |
| tag | `#00e5ff` | Neon cyan |
| attribute | `#ff6e27` | Neon orange |
| symbol | `#ffe600` | Neon yellow |
| meta | `#8a9bb5` | Steel blue |
| addition | `#39ff14` | Neon green |
| deletion | `#ff3366` | Neon red-pink |
| property | `#00e5ff` | Neon cyan |
| punctuation | `#6b5b95` | Muted purple |

#### `terminal` (xterm ANSI colors)

| Token | Hex |
|-------|-----|
| background | `#0d0221` |
| foreground | `#e0f0ff` |
| cursor | `#ff2d95` |
| cursorAccent | `#0d0221` |
| selectionBackground | `#2e1e6666` |
| selectionForeground | `#e0f0ff` |
| black | `#1a0a3e` |
| red | `#ff3366` |
| green | `#39ff14` |
| yellow | `#ffe600` |
| blue | `#00e5ff` |
| magenta | `#ff2d95` |
| cyan | `#00ffff` |
| white | `#a8b8d0` |
| brightBlack | `#2e1e66` |
| brightRed | `#ff6688` |
| brightGreen | `#66ff44` |
| brightYellow | `#ffee55` |
| brightBlue | `#44eeff` |
| brightMagenta | `#ff55aa` |
| brightCyan | `#55ffff` |
| brightWhite | `#e0f0ff` |

#### Font override

```
'Orbitron', 'Share Tech Mono', 'SF Mono', 'Fira Code', monospace
```

### Registration

- New builtin theme ID: `'cyberpunk'` added to `BuiltinThemeId` union.
- Theme file: `src/renderer/themes/cyberpunk.ts`
- Registered in `src/renderer/themes/index.ts` alongside existing themes.

### Files to create/modify

| File | Change |
|------|--------|
| `src/shared/types.ts` | Add `'cyberpunk'` to `BuiltinThemeId` |
| `src/renderer/themes/cyberpunk.ts` | New theme definition file |
| `src/renderer/themes/index.ts` | Import and register cyberpunk theme |
