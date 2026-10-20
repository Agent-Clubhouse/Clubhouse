import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

const captureFromShortcut = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('./ipc/feedback-handlers', () => ({ captureFromShortcut }));
vi.mock('./services/framebriar', () => ({ FEEDBACK_CAPTURE_MENU_ID: 'feedback-capture' }));
vi.mock('./services/log-service', () => ({ appLog: vi.fn() }));

import { buildMenu, FEEDBACK_CAPTURE_ACCELERATOR } from './menu';
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

  it('offers Capture Feedback Screenshot in Help, off until feedback can capture (#2101)', () => {
    const help = capturedTemplate.find((m) => m.role === 'help');
    const item = (help?.submenu as MenuItemConstructorOptions[] | undefined)?.find((i) => i.id === 'feedback-capture');
    expect(item).toMatchObject({ label: 'Capture Feedback Screenshot', accelerator: 'CmdOrCtrl+Shift+2', enabled: false });
    expect(FEEDBACK_CAPTURE_ACCELERATOR).toBe('CmdOrCtrl+Shift+2');
    const click = item!.click as (item: unknown, win: unknown) => void;
    click({}, undefined);
    expect(captureFromShortcut).toHaveBeenLastCalledWith(null);
    const win = { webContents: {} };
    click({}, win);
    expect(captureFromShortcut).toHaveBeenLastCalledWith(win);
  });
});

describe('Window menu', () => {
  const originalPlatform = process.platform;
  afterEach(() => Object.defineProperty(process, 'platform', { value: originalPlatform }));

  // Role 'windowMenu' with no submenu adds Close (Ctrl+W) off macOS; closing the
  // main window there quits the app.
  for (const platform of ['win32', 'linux', 'darwin'] as const) {
    it(`${platform}: has an explicit submenu with no Close item`, () => {
      Object.defineProperty(process, 'platform', { value: platform });
      buildMenu();
      const windowMenu = capturedTemplate.find((i) => i.role === 'windowMenu')!;
      const submenu = windowMenu.submenu as MenuItemConstructorOptions[];
      expect(Array.isArray(submenu)).toBe(true);
      expect(submenu.some((i) => i.role === 'close')).toBe(false);
      expect(submenu.some((i) => i.role === 'front')).toBe(platform === 'darwin');
    });
  }
});
