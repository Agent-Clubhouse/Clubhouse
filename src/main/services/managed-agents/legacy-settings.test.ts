import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClubhouseModeSettings, McpSettings } from '../../../shared/types';

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => os.tmpdir() } }));
vi.mock('../log-service', () => ({ appLog: vi.fn() }));

const h = vi.hoisted(() => ({
  mcp: { enabled: false } as McpSettings,
  mode: { enabled: false } as ClubhouseModeSettings,
  scp: undefined as 'github' | 'azure-devops' | undefined,
  failMcpSave: false,
}));

vi.mock('../mcp-settings', () => ({
  getSettings: () => structuredClone(h.mcp),
  saveSettings: vi.fn(async (next: McpSettings) => {
    if (h.failMcpSave) throw Object.assign(new Error('EACCES: /x'), { code: 'EACCES' });
    h.mcp = structuredClone(next);
  }),
  notifyMcpEnablementChanged: vi.fn(),
}));
vi.mock('../clubhouse-mode-settings', () => ({ getSettings: () => structuredClone(h.mode) }));
vi.mock('../source-control-settings', () => ({
  getAppSourceControlProvider: () => h.scp,
  setAppSourceControlProvider: vi.fn(async (p: 'github' | 'azure-devops') => { h.scp = p; }),
}));

import * as mcpSettings from '../mcp-settings';
import { createManagedStateStore, type ManagedStateStore } from './state-store';
import { MCP_FROM_CLUBHOUSE_MODE, mcpSettingsWithoutClubhouseMode, migrateLegacySettings, SOURCE_CONTROL_PROVIDER } from './legacy-settings';

/** isMcpEnabled's chain, MCP settings first, then Clubhouse Mode. */
function resolve(mcp: McpSettings, mode: ClubhouseModeSettings, project: string, withFallback: boolean): boolean {
  if (mcp.projectOverrides?.[project] !== undefined) return mcp.projectOverrides[project];
  if (mcp.enabled) return true;
  if (!withFallback) return false;
  return mode.projectOverrides?.[project] ?? mode.enabled;
}

let state: ManagedStateStore;

beforeEach(() => {
  state = createManagedStateStore(fs.mkdtempSync(path.join(os.tmpdir(), 'managed-legacy-')));
  h.mcp = { enabled: false };
  h.mode = { enabled: false };
  h.scp = undefined;
  h.failMcpSave = false;
  vi.mocked(mcpSettings.saveSettings).mockClear();
});

describe('MCP settings without the Clubhouse Mode fallback (D63)', () => {
  const cases: Array<[string, McpSettings, ClubhouseModeSettings]> = [
    ['app on', { enabled: false }, { enabled: true }],
    ['app on, one project off', { enabled: false }, { enabled: true, projectOverrides: { a: false, b: true } }],
    ['app off, one project on', { enabled: false }, { enabled: false, projectOverrides: { a: true, b: false } }],
    ['MCP project off wins', { enabled: false, projectOverrides: { a: false } }, { enabled: true, projectOverrides: { a: true } }],
    ['MCP on already', { enabled: true, projectOverrides: { c: false } }, { enabled: true, projectOverrides: { a: false } }],
    ['nothing on', { enabled: false, projectOverrides: { c: true } }, { enabled: false }],
  ];

  it.each(cases)('%s: every project resolves the same without the fallback as it does with it now', (_name, mcp, mode) => {
    const next = mcpSettingsWithoutClubhouseMode(mcp, mode) ?? mcp;
    for (const project of ['a', 'b', 'c', 'other']) {
      expect(resolve(next, mode, project, false), project).toBe(resolve(mcp, mode, project, true));
    }
  });

  it('changes nothing when Clubhouse Mode decides nothing', () => {
    expect(mcpSettingsWithoutClubhouseMode({ enabled: true }, { enabled: true })).toBeNull();
    expect(mcpSettingsWithoutClubhouseMode({ enabled: false }, { enabled: false })).toBeNull();
    expect(mcpSettingsWithoutClubhouseMode({ enabled: false, projectOverrides: { a: false } }, { enabled: false, projectOverrides: { a: true } })).toBeNull();
  });
});

describe('migrateLegacySettings', () => {
  it('turns MCP on where Clubhouse Mode does, and a second start with nothing new changes nothing', async () => {
    h.mode = { enabled: true, projectOverrides: { a: false } };
    expect(await migrateLegacySettings(state)).toEqual({ mcp: true, sourceControl: false });
    expect(h.mcp).toEqual({ enabled: true, projectOverrides: { a: false } });
    expect(mcpSettings.notifyMcpEnablementChanged).toHaveBeenCalled();
    expect((await state.read()).migrations?.[MCP_FROM_CLUBHOUSE_MODE]).toEqual(expect.any(String));

    vi.mocked(mcpSettings.saveSettings).mockClear();
    expect(await migrateLegacySettings(state)).toEqual({ mcp: false, sourceControl: false });
    expect(mcpSettings.saveSettings).not.toHaveBeenCalled();
    expect(h.mcp).toEqual({ enabled: true, projectOverrides: { a: false } });
  });

  it('runs at every start: Clubhouse Mode turned on for a project after the first run is made explicit at the next', async () => {
    // First run: nothing to make explicit.
    expect(await migrateLegacySettings(state)).toEqual({ mcp: false, sourceControl: false });
    expect(mcpSettings.saveSettings).not.toHaveBeenCalled();

    // Later, Clubhouse Mode is turned on for project b only.
    h.mode = { enabled: false, projectOverrides: { b: true } };
    expect((await migrateLegacySettings(state)).mcp).toBe(true);
    expect(h.mcp).toEqual({ enabled: false, projectOverrides: { b: true } });
    for (const project of ['a', 'b']) {
      expect(resolve(h.mcp, h.mode, project, false), project).toBe(resolve(h.mcp, h.mode, project, true));
    }
  });

  it('records nothing when the save fails, so the next start tries again', async () => {
    h.mode = { enabled: true };
    h.failMcpSave = true;
    expect((await migrateLegacySettings(state)).mcp).toBe(false);
    expect((await state.read()).migrations?.[MCP_FROM_CLUBHOUSE_MODE]).toBeUndefined();
    h.failMcpSave = false;
    expect((await migrateLegacySettings(state)).mcp).toBe(true);
    expect(h.mcp.enabled).toBe(true);
  });

  it('moves the app-level source control provider once, without replacing one set in its new home (D61)', async () => {
    h.mode = { enabled: false, sourceControlProvider: 'azure-devops' };
    expect((await migrateLegacySettings(state)).sourceControl).toBe(true);
    expect(h.scp).toBe('azure-devops');
    expect((await state.read()).migrations?.[SOURCE_CONTROL_PROVIDER]).toEqual(expect.any(String));

    const fresh = createManagedStateStore(fs.mkdtempSync(path.join(os.tmpdir(), 'managed-legacy-')));
    h.scp = 'github';
    expect((await migrateLegacySettings(fresh)).sourceControl).toBe(false);
    expect(h.scp).toBe('github');
  });

  it('keeps the rest of managed state', async () => {
    await state.update((s) => { s.defaultHelperTemplateId = 'builtin-template-helper'; });
    await migrateLegacySettings(state);
    const read = await state.read();
    expect(read.defaultHelperTemplateId).toBe('builtin-template-helper');
    // The source control move is once-only; the MCP one runs every start and records only when it changed something.
    expect(Object.keys(read.migrations ?? {}).sort()).toEqual([SOURCE_CONTROL_PROVIDER]);
  });
});
