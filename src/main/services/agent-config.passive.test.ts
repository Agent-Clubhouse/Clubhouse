import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Real temporary files, with no watcher events: recovery must notify explicitly.
vi.mock('fs', async (importOriginal) => ({
  ...await importOriginal<typeof import('fs')>(),
  watch: vi.fn(() => ({ on: vi.fn().mockReturnThis(), close: vi.fn() })),
}));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('./agent-system', () => ({ resolveOrchestrator: vi.fn() }));
vi.mock('./agent-settings-service', () => ({ applyAgentDefaults: vi.fn(), readProjectAgentDefaults: vi.fn(async () => ({})) }));
vi.mock('./chat-idle-settings', () => ({ setAgentIdleSleep: vi.fn() }));
import { addSessionEntry, auditRecovery, clearAgentConfigCache, getBackupInfo, getDurableConfig, getParentAgent, getSessionHistory, getWorktreeStatus, initializeDurableProjects, onAgentConfigChanged, peekCachedDurableConfig, listDurable, listHelpers, quarantineSession, restoreFromBackup, updateSessionId } from './agent-config';

let project: string;
let primary: string;
let backup: string;
const saved = { id: 'durable_policy', name: 'saved restricted', color: 'indigo', createdAt: '2026-11-17', sandbox: 'read-only', approvalPolicy: 'untrusted' };
const older = { id: saved.id, name: 'older unrestricted', color: 'indigo', createdAt: '2026-11-16', access: 'full_access' };
beforeEach(() => {
  clearAgentConfigCache();
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'clubhouse-passive-policy-'));
  fs.mkdirSync(path.join(project, '.clubhouse'));
  primary = path.join(project, '.clubhouse', 'agents.json');
  backup = `${primary}.bak`;
  fs.writeFileSync(primary, JSON.stringify([saved]));
  fs.writeFileSync(backup, JSON.stringify([older]));
});
afterEach(() => { clearAgentConfigCache(); fs.rmSync(project, { recursive: true, force: true }); });

describe('passive durable reads and deliberate backup recovery (#3686)', () => {
  it('strict snapshots validate without migrating or rewriting healthy storage', async () => {
    const legacy = { ...saved, structuredMode: true };
    fs.writeFileSync(primary, JSON.stringify([legacy]));
    const before = fs.readFileSync(primary, 'utf8');
    expect(await getDurableConfig(project, saved.id, { forLaunch: true })).toMatchObject(legacy);
    expect(fs.readFileSync(primary, 'utf8')).toBe(before);
    expect(fs.readFileSync(backup, 'utf8')).toBe(JSON.stringify([older]));
  });

  it('keeps backup records visible without restoring, caching or hiding launch uncertainty', async () => {
    expect(await getDurableConfig(project, saved.id)).toMatchObject(saved);
    fs.writeFileSync(primary, '{corrupt primary');
    expect(await listDurable(project)).toMatchObject([older]);
    expect(await getDurableConfig(project, saved.id)).toMatchObject(older);
    await getSessionHistory(project, saved.id);
    await listHelpers(project, saved.id);
    await getParentAgent(project, saved.id);
    await getWorktreeStatus(project, saved.id);
    await auditRecovery(project, new Set());
    expect(await getBackupInfo(project)).toMatchObject({ recoveryRequired: true, backupAgents: [older] });
    expect(fs.readFileSync(primary, 'utf8')).toBe('{corrupt primary');
    expect(fs.readFileSync(backup, 'utf8')).toBe(JSON.stringify([older]));
    await expect(getDurableConfig(project, saved.id, { forLaunch: true })).rejects.toThrow();
  });

  it.each(['session', 'quarantine', 'history'] as const)('refuses a lifecycle %s write before it can restore an older policy', async (operation) => {
    fs.writeFileSync(primary, '{corrupt primary');
    const write = operation === 'session' ? updateSessionId(project, saved.id, null)
      : operation === 'quarantine' ? quarantineSession(project, saved.id, 's1')
      : addSessionEntry(project, saved.id, { sessionId: 's1', startedAt: '', lastActiveAt: '' });
    await expect(write).rejects.toThrow();
    expect(fs.readFileSync(primary, 'utf8')).toBe('{corrupt primary');
    expect(fs.readFileSync(backup, 'utf8')).toBe(JSON.stringify([older]));
  });

  it('restores only through the explicit recovery action, preserving the backup and its chosen policy', async () => {
    fs.writeFileSync(primary, '{corrupt primary');
    const info = await getBackupInfo(project);
    expect(info).toMatchObject({ recoveryRequired: true, backupAgents: [older] });
    expect(fs.readFileSync(primary, 'utf8')).toBe('{corrupt primary');
    const notified: Array<string | undefined> = [];
    const stop = onAgentConfigChanged((changed) => {
      if (changed === project) notified.push(peekCachedDurableConfig(project, saved.id)?.name);
    });
    try {
      expect(await restoreFromBackup(project)).toMatchObject({ restoredCount: 1, agents: [older] });
      expect(notified).toContain(older.name);
    } finally { stop(); }
    expect(JSON.parse(fs.readFileSync(primary, 'utf8'))).toEqual([older]);
    expect(fs.readFileSync(backup, 'utf8')).toBe(JSON.stringify([older]));
    expect(await getDurableConfig(project, saved.id, { forLaunch: true })).toMatchObject(older);
  });

  it('shows uncertain storage even when there is no usable backup and refuses restoration', async () => {
    fs.writeFileSync(primary, '{corrupt primary');
    fs.writeFileSync(backup, '{corrupt backup');
    expect(await getBackupInfo(project)).toMatchObject({ recoveryRequired: true, backupAgents: [] });
    await expect(restoreFromBackup(project)).rejects.toThrow('No valid backup');
    expect(fs.readFileSync(primary, 'utf8')).toBe('{corrupt primary');
  });
});

it('initializes copied project IDs and duplicate records before either first list (#3686)', async () => {
  const copy = `${project}-copy`;
  fs.mkdirSync(path.join(copy, '.clubhouse'), { recursive: true });
  fs.writeFileSync(primary, JSON.stringify([saved, saved]));
  fs.writeFileSync(path.join(copy, '.clubhouse', 'agents.json'), JSON.stringify([saved, saved]));
  try {
    const initializeFirst = initializeDurableProjects([{ path: project }]);
    const first = await listDurable(project); // Waits for initialization already underway.
    await initializeFirst;
    const initializeCopy = initializeDurableProjects([{ path: copy }]);
    const copied = await listDurable(copy);
    await initializeCopy;
    expect(first).toHaveLength(1);
    expect(copied).toHaveLength(1);
    expect(first[0].id).toBe(saved.id);
    expect(copied[0].id).not.toBe(saved.id);
    expect(copied[0]).toMatchObject({ sandbox: 'read-only', approvalPolicy: 'untrusted' });
    expect(JSON.parse(fs.readFileSync(path.join(copy, '.clubhouse', 'agents.json'), 'utf8'))).toEqual(copied);
  } finally { clearAgentConfigCache(copy); fs.rmSync(copy, { recursive: true, force: true }); }
});
