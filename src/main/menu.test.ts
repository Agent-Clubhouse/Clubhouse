import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MenuItemConstructorOptions } from 'electron';

// ── Mock electron ───────────────────────────────────────────────────────────

let capturedTemplate: MenuItemConstructorOptions[] = [];

const mockWebContentsSend = vi.fn();
const mockFocusedWindow = { webContents: { send: mockWebContentsSend } };

vi.mock('electron', () => {
  const mockApp = { name: 'Clubhouse' };
  const mockMenu = {
    setApplicationMenu: vi.fn(),
    buildFromTemplate: vi.fn((template: MenuItemConstructorOptions[]) => {
      capturedTemplate = template;
      return template;
    }),
  };
  const mockBrowserWindow = {
    getFocusedWindow: vi.fn(() => mockFocusedWindow),
  };
  return {
    app: mockApp,
    Menu: mockMenu,
    BrowserWindow: mockBrowserWindow,
  };
});

import { buildMenu } from './menu';
import { Menu } from 'electron';

describe('buildMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedTemplate = [];
    buildMenu();
  });

  it('builds and sets the application menu', () => {
    expect(Menu.buildFromTemplate).toHaveBeenCalled();
    expect(Menu.setApplicationMenu).toHaveBeenCalled();
  });

  it('includes a custom Edit menu with standard edit operations', () => {
    const editMenu = capturedTemplate.find((item) => item.label === 'Edit');
    expect(editMenu).toBeDefined();
    expect(editMenu!.submenu).toBeDefined();

    const submenu = editMenu!.submenu as MenuItemConstructorOptions[];
    const labels = submenu.filter((item) => item.label).map((item) => item.label);

    expect(labels).toContain('Undo');
    expect(labels).toContain('Redo');
    expect(labels).toContain('Cut');
    expect(labels).toContain('Copy');
    expect(labels).toContain('Paste');
    expect(labels).toContain('Select All');
  });

  it('does NOT use role-based editMenu (which bypasses renderer)', () => {
    // The old { role: 'editMenu' } intercepts keystrokes at the native OS level
    // before they reach the renderer, breaking Monaco editor keyboard shortcuts.
    const roleBasedEditMenu = capturedTemplate.find(
      (item) => (item as any).role === 'editMenu',
    );
    expect(roleBasedEditMenu).toBeUndefined();
  });

  it('sends IPC edit command when Select All is clicked', () => {
    const editMenu = capturedTemplate.find((item) => item.label === 'Edit');
    const submenu = editMenu!.submenu as MenuItemConstructorOptions[];
    const selectAll = submenu.find((item) => item.label === 'Select All');
    expect(selectAll).toBeDefined();
    expect(selectAll!.accelerator).toBe('CmdOrCtrl+A');

    // Simulate click
    selectAll!.click!(null as any, null as any, null as any);

    expect(mockWebContentsSend).toHaveBeenCalledWith('app:edit-command', 'selectAll');
  });

  it('sends IPC edit command when Copy is clicked', () => {
    const editMenu = capturedTemplate.find((item) => item.label === 'Edit');
    const submenu = editMenu!.submenu as MenuItemConstructorOptions[];
    const copy = submenu.find((item) => item.label === 'Copy');
    expect(copy).toBeDefined();

    copy!.click!(null as any, null as any, null as any);

    expect(mockWebContentsSend).toHaveBeenCalledWith('app:edit-command', 'copy');
  });
});
