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

  it('uses role-based editMenu for native OS edit command handling', () => {
    const editMenu = capturedTemplate.find(
      (item) => (item as any).role === 'editMenu',
    );
    expect(editMenu).toBeDefined();
  });

  it('includes app menu with About and Preferences', () => {
    const appMenu = capturedTemplate.find((item) => item.label === 'Clubhouse');
    expect(appMenu).toBeDefined();
    const submenu = appMenu!.submenu as MenuItemConstructorOptions[];
    const labels = submenu.filter((item) => item.label).map((item) => item.label);
    expect(labels).toContain('About Clubhouse');
    expect(labels).toContain('Preferences…');
  });
});
