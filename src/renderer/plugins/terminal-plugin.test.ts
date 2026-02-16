import { describe, it, expect, vi } from 'vitest';

vi.mock('../features/terminal/StandaloneTerminal', () => ({ StandaloneTerminal: () => null }));

import { terminalPlugin } from './terminal-plugin';

describe('terminal plugin', () => {
  it('has correct id and label', () => {
    expect(terminalPlugin.id).toBe('terminal');
    expect(terminalPlugin.label).toBe('Terminal');
  });

  it('is fullWidth', () => {
    expect(terminalPlugin.fullWidth).toBe(true);
  });

  it('provides MainPanel but no SidebarPanel', () => {
    expect(terminalPlugin.MainPanel).toBeDefined();
    expect(terminalPlugin.SidebarPanel).toBeUndefined();
  });
});
