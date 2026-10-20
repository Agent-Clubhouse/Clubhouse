import { describe, it, expect } from 'vitest';
import { getBuiltinPlugins } from './index';
import { LEGACY_SHORTCUTS, CHROME_SHORTCUTS } from '../../stores/keyboardShortcutsStore';
import { getCommandActions } from '../../features/command-palette/command-actions';
import { bindingChord, bindingClaimsEditingKey, KEY_PLATFORMS } from '../../editing-keys';

// plugin-hotkeys drops a plugin binding that collides with an app shortcut or
// another plugin's, so a colliding default ships as a silently dead shortcut.
describe('built-in plugin default shortcuts', () => {
  const bindings = getBuiltinPlugins({ goobers: true }).flatMap(({ manifest }) =>
    (manifest.contributes?.commands ?? [])
      .filter((c) => c.defaultBinding)
      .map((c) => ({ id: `${manifest.id}:${c.id}`, binding: c.defaultBinding! })));

  it.each([
    ['legacy', LEGACY_SHORTCUTS],
    ['new chrome', CHROME_SHORTCUTS],
  ])('do not collide with %s app shortcuts', (_shell, shortcuts) => {
    const app = new Map(shortcuts.map((s) => [s.defaultBinding, s.id]));
    const collisions = bindings.filter((b) => app.has(b.binding)).map((b) => `${b.id} vs ${app.get(b.binding)}`);
    expect(collisions).toEqual([]);
  });

  it('do not collide with each other', () => {
    const seen = new Map<string, string>();
    const collisions: string[] = [];
    for (const b of bindings) {
      const owner = seen.get(b.binding);
      if (owner) collisions.push(`${b.id} vs ${owner}`);
      else seen.set(b.binding, b.id);
    }
    expect(collisions).toEqual([]);
  });
});

// A global binding fires while focus is in a text input, so one on an editing
// key would take that key from every input (#2314: Review had Cmd+Left/Right).
describe('global default shortcuts and editing keys', () => {
  const globalActionIds = new Set(getCommandActions().filter((a) => a.global).map((a) => a.id));
  const globals = [
    ...[...LEGACY_SHORTCUTS, ...CHROME_SHORTCUTS]
      .filter((s) => globalActionIds.has(s.id))
      .map((s) => ({ id: s.id, binding: s.defaultBinding })),
    ...getBuiltinPlugins({ goobers: true }).flatMap(({ manifest }) =>
      (manifest.contributes?.commands ?? [])
        .filter((c) => c.global && c.defaultBinding)
        .map((c) => ({ id: `${manifest.id}:${c.id}`, binding: c.defaultBinding! }))),
  ];

  it('include the app and plugin globals', () => {
    expect(globals.map((g) => g.id)).toEqual(expect.arrayContaining(['command-palette', 'review:review-prev', 'review:review-next']));
  });

  it.each(KEY_PLATFORMS)('claim no editing key on %s', (platform) => {
    const claims = globals
      .filter((g) => bindingClaimsEditingKey(g.binding, platform))
      .map((g) => `${g.id} (${bindingChord(g.binding, platform)})`);
    expect(claims).toEqual([]);
  });

  it('catches the binding #2314 shipped', () => {
    expect(bindingClaimsEditingKey('Meta+ArrowLeft', 'darwin')).toBe(true);
    expect(bindingClaimsEditingKey('Meta+ArrowLeft', 'win32')).toBe(true);
    expect(bindingClaimsEditingKey('Meta+ArrowLeft', 'linux')).toBe(true);
  });
});
