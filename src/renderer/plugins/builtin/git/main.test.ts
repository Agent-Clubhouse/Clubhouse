import { describe, it, expect } from 'vitest';
import { activate, deactivate, SidebarPanel, MainPanel } from './main';
import type { PluginModule } from '../../../../shared/plugin-types';

describe('git plugin module', () => {
  it('exports activate function', () => {
    expect(typeof activate).toBe('function');
  });

  it('exports deactivate function', () => {
    expect(typeof deactivate).toBe('function');
  });

  it('exports SidebarPanel component', () => {
    expect(typeof SidebarPanel).toBe('function');
  });

  it('exports MainPanel component', () => {
    expect(typeof MainPanel).toBe('function');
  });

  it('satisfies PluginModule interface', () => {
    const mod: PluginModule = { activate, deactivate, SidebarPanel, MainPanel };
    expect(mod.activate).toBe(activate);
    expect(mod.deactivate).toBe(deactivate);
    expect(mod.SidebarPanel).toBe(SidebarPanel);
    expect(mod.MainPanel).toBe(MainPanel);
  });
});
