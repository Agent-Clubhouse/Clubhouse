import { describe, it, expect } from 'vitest';
import { getBuiltinPlugins } from './index';
import { LEGACY_SHORTCUTS, CHROME_SHORTCUTS } from '../../stores/keyboardShortcutsStore';

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
