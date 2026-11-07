import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LegacyClubhouseModeSettings as ClubhouseModeSettings } from './legacy-migration';

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => os.tmpdir() } }));
vi.mock('../log-service', () => ({ appLog: vi.fn() }));

const h = vi.hoisted(() => ({
  mode: { enabled: false } as ClubhouseModeSettings,
  scp: undefined as 'github' | 'azure-devops' | undefined,
  failScpSave: false,
}));

// The old clubhouse-mode-settings.json, read as plain JSON (legacy-migration.test covers the read).
vi.mock('./legacy-migration', () => ({ readLegacyClubhouseModeSettings: () => structuredClone(h.mode) }));
vi.mock('../source-control-settings', () => ({
  getAppSourceControlProvider: () => h.scp,
  setAppSourceControlProvider: vi.fn(async (p: 'github' | 'azure-devops') => {
    if (h.failScpSave) throw Object.assign(new Error('EACCES: /x'), { code: 'EACCES' });
    h.scp = p;
  }),
}));

import { createManagedStateStore, type ManagedStateStore } from './state-store';
import { migrateLegacySettings, SOURCE_CONTROL_PROVIDER } from './legacy-settings';

let state: ManagedStateStore;

beforeEach(() => {
  state = createManagedStateStore(fs.mkdtempSync(path.join(os.tmpdir(), 'managed-legacy-')));
  h.mode = { enabled: false };
  h.scp = undefined;
  h.failScpSave = false;
});

describe('migrateLegacySettings', () => {
  it('moves the app-level source control provider once, without replacing one set in its new home (D61)', async () => {
    h.mode = { enabled: false, sourceControlProvider: 'azure-devops' };
    expect(await migrateLegacySettings(state)).toEqual({ sourceControl: true });
    expect(h.scp).toBe('azure-devops');
    expect((await state.read()).migrations?.[SOURCE_CONTROL_PROVIDER]).toEqual(expect.any(String));

    const fresh = createManagedStateStore(fs.mkdtempSync(path.join(os.tmpdir(), 'managed-legacy-')));
    h.scp = 'github';
    expect((await migrateLegacySettings(fresh)).sourceControl).toBe(false);
    expect(h.scp).toBe('github');
  });

  it('runs once: a later old value is not copied again', async () => {
    await migrateLegacySettings(state);
    h.mode = { enabled: false, sourceControlProvider: 'azure-devops' };
    expect((await migrateLegacySettings(state)).sourceControl).toBe(false);
    expect(h.scp).toBeUndefined();
  });

  it('records nothing when the save fails, so the next start tries again', async () => {
    h.mode = { enabled: false, sourceControlProvider: 'azure-devops' };
    h.failScpSave = true;
    expect((await migrateLegacySettings(state)).sourceControl).toBe(false);
    expect((await state.read()).migrations?.[SOURCE_CONTROL_PROVIDER]).toBeUndefined();
    h.failScpSave = false;
    expect((await migrateLegacySettings(state)).sourceControl).toBe(true);
  });

  it('keeps the rest of managed state, and makes no MCP setting explicit any more (D69)', async () => {
    h.mode = { enabled: true, projectOverrides: { '/p': true } };
    await state.update((s) => { s.defaultHelperTemplateId = 'builtin-template-helper'; });
    await migrateLegacySettings(state);
    const read = await state.read();
    expect(read.defaultHelperTemplateId).toBe('builtin-template-helper');
    expect(Object.keys(read.migrations ?? {}).sort()).toEqual([SOURCE_CONTROL_PROVIDER]);
  });
});
