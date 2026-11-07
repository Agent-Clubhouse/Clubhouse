import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const W = vi.hoisted(() => ({
  userData: '',
  projects: [] as Array<{ id: string; name: string; path: string; displayName?: string }>,
  defaults: new Map<string, Record<string, unknown>>(),
  shellEnv: {} as Record<string, string>,
}));

vi.mock('electron', () => ({ app: { getPath: () => W.userData } }));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('./project-store', () => ({ peekProjects: async () => W.projects }));
vi.mock('./agent-settings-service', () => ({ readProjectAgentDefaults: async (p: string) => W.defaults.get(p) ?? {} }));
vi.mock('../util/shell', () => ({ getShellEnvironment: () => W.shellEnv }));

import { appLog } from './log-service';
import { noteRemovedProviderProfiles, removedProfileStateDirs, takeRemovedProfilesNotice } from './provider-profiles-removed';

const SECRET = 'sk-never-logged-7f3a';
const profilesFile = () => path.join(W.userData, 'profiles.json');
const notedFile = () => path.join(W.userData, 'profiles-removed.json');
const logged = () => JSON.stringify(vi.mocked(appLog).mock.calls);

function saveProfiles(profiles: unknown): string {
  const text = JSON.stringify({ profiles });
  fs.writeFileSync(profilesFile(), text);
  return text;
}

beforeEach(() => {
  vi.clearAllMocks();
  W.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'clubhouse-profiles-removed-'));
  W.projects = [];
  W.defaults = new Map();
  W.shellEnv = {};
});

afterEach(() => {
  fs.rmSync(W.userData, { recursive: true, force: true });
});

describe('noteRemovedProviderProfiles (#2749)', () => {
  it('says nothing, and writes nothing, without a profiles file', async () => {
    expect(await noteRemovedProviderProfiles()).toBe('none');
    expect(appLog).not.toHaveBeenCalled();
    expect(fs.existsSync(notedFile())).toBe(false);
  });

  it('says nothing when the file holds no profiles', async () => {
    saveProfiles([]);
    expect(await noteRemovedProviderProfiles()).toBe('none');
    expect(appLog).not.toHaveBeenCalled();
  });

  it('logs once which projects used a profile and which variables it set, never their values, and keeps the file', async () => {
    const original = saveProfiles([
      { id: 'work', name: 'Work account', orchestrators: { 'claude-code': { env: { CLAUDE_CONFIG_DIR: '~/.claude-work', ANTHROPIC_API_KEY: SECRET } } } },
      { id: 'home', name: 'Home', orchestrators: { 'codex-cli': { env: { CODEX_HOME: '~/.codex-home' } } } },
    ]);
    const work = path.join(W.userData, 'work-project');
    const gone = path.join(W.userData, 'gone-profile');
    W.projects = [
      { id: 'p1', name: 'work-project', displayName: 'Work app', path: work },
      { id: 'p2', name: 'plain', path: path.join(W.userData, 'plain') },
      { id: 'p3', name: 'gone-profile', path: gone },
    ];
    W.defaults.set(work, { profileId: 'work' });
    W.defaults.set(gone, { profileId: 'deleted' });

    expect(await noteRemovedProviderProfiles()).toBe('noted');
    expect(appLog).toHaveBeenCalledTimes(1);
    const [, level, message, opts] = vi.mocked(appLog).mock.calls[0];
    expect(level).toBe('warn');
    expect(message).toContain('Provider profiles were removed');
    expect(opts?.meta).toEqual({
      profileCount: 2,
      variablesByProfile: [{ 'claude-code': ['ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR'] }, { 'codex-cli': ['CODEX_HOME'] }],
      projects: [
        { project: 'Work app', variables: { 'claude-code': ['ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR'] } },
        { project: 'gone-profile', variables: 'profile_missing' },
      ],
    });
    expect(logged()).not.toContain(SECRET);
    expect(logged()).not.toContain('.claude-work');
    expect(logged()).not.toContain('Work account');
    // The person's file is never deleted or changed.
    expect(fs.readFileSync(profilesFile(), 'utf-8')).toBe(original);

    vi.mocked(appLog).mockClear();
    expect(await noteRemovedProviderProfiles()).toBe('already_noted');
    expect(appLog).not.toHaveBeenCalled();
  });

  it('logs once, without content, for a file it cannot read', async () => {
    fs.writeFileSync(profilesFile(), `{"profiles": [ ${SECRET}`);
    expect(await noteRemovedProviderProfiles()).toBe('unreadable');
    expect(appLog).toHaveBeenCalledTimes(1);
    expect(logged()).not.toContain(SECRET);
    expect(await noteRemovedProviderProfiles()).toBe('already_noted');
    expect(fs.existsSync(profilesFile())).toBe(true);
  });

  it('tolerates malformed entries in an old file', async () => {
    saveProfiles([null, { name: 'no id' }, { id: 'ok', orchestrators: { 'claude-code': null, 'codex-cli': { env: 'x' } } }]);
    expect(await noteRemovedProviderProfiles()).toBe('noted');
    expect(vi.mocked(appLog).mock.calls[0][3]?.meta).toMatchObject({ profileCount: 1, variablesByProfile: [{ 'claude-code': [], 'codex-cli': [] }] });
  });
});

describe('takeRemovedProfilesNotice (#2749)', () => {
  it('returns each removed profile\'s name and variable names once, never values, and keeps the file', async () => {
    const original = saveProfiles([
      { id: 'work', name: 'Work', orchestrators: { 'claude-code': { env: { CLAUDE_CONFIG_DIR: '~/.claude-work', ANTHROPIC_API_KEY: SECRET } } } },
      { id: 'p2', orchestrators: { 'codex-cli': { env: { CODEX_HOME: '/x' } } } },
    ]);
    const notice = await takeRemovedProfilesNotice();
    expect(notice).toEqual({ profiles: [
      { name: 'Work', variables: { 'claude-code': ['ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR'] } },
      { name: 'p2', variables: { 'codex-cli': ['CODEX_HOME'] } },
    ] });
    expect(JSON.stringify(notice)).not.toContain(SECRET);
    expect(await takeRemovedProfilesNotice()).toBeNull();
    expect(fs.readFileSync(profilesFile(), 'utf-8')).toBe(original);
  });

  it('is null without saved profiles', async () => {
    expect(await takeRemovedProfilesNotice()).toBeNull();
    saveProfiles([]);
    expect(await takeRemovedProfilesNotice()).toBeNull();
  });

  it('and the log line each happen once, in either order, even started together', async () => {
    saveProfiles([{ id: 'work', name: 'Work', orchestrators: { 'claude-code': { env: { CLAUDE_CONFIG_DIR: '/w' } } } }]);
    const [logged, notice] = await Promise.all([noteRemovedProviderProfiles(), takeRemovedProfilesNotice()]);
    expect(logged).toBe('noted');
    expect(notice?.profiles).toHaveLength(1);
    expect(await noteRemovedProviderProfiles()).toBe('already_noted');
    expect(await takeRemovedProfilesNotice()).toBeNull();
  });

  it('still shows once after an older build logged the line', async () => {
    saveProfiles([{ id: 'work', name: 'Work', orchestrators: {} }]);
    fs.writeFileSync(notedFile(), JSON.stringify({ notedAt: '2026-11-07T00:00:00.000Z' }));
    expect(await takeRemovedProfilesNotice()).toEqual({ profiles: [{ name: 'Work', variables: {} }] });
    expect(await noteRemovedProviderProfiles()).toBe('already_noted');
  });
});

describe('removedProfileStateDirs (#2749)', () => {
  it('lists the state folders saved profiles gave a CLI, with ~ expanded', async () => {
    saveProfiles([
      { id: 'a', orchestrators: { 'codex-cli': { env: { CODEX_HOME: '~/.codex-work', OPENAI_API_KEY: SECRET } } } },
      { id: 'b', orchestrators: { 'codex-cli': { env: { CODEX_HOME: path.join(W.userData, 'codex-home') } }, 'claude-code': { env: { ANTHROPIC_API_KEY: SECRET } } } },
    ]);
    expect(await removedProfileStateDirs('codex-cli')).toEqual([path.join(W.userData, '.codex-work'), path.join(W.userData, 'codex-home')]);
    expect(await removedProfileStateDirs('claude-code')).toEqual([]);
    expect(await removedProfileStateDirs('gemini')).toEqual([]);
  });

  it('leaves out the folder the launch environment already uses', async () => {
    const current = path.join(W.userData, 'codex-home');
    saveProfiles([{ id: 'a', orchestrators: { 'codex-cli': { env: { CODEX_HOME: current } } } }]);
    W.shellEnv = { CODEX_HOME: current };
    expect(await removedProfileStateDirs('codex-cli')).toEqual([]);
  });

  it('is empty without a profiles file, or with one it can\'t read', async () => {
    expect(await removedProfileStateDirs('codex-cli')).toEqual([]);
    fs.writeFileSync(profilesFile(), '{nope');
    expect(await removedProfileStateDirs('codex-cli')).toEqual([]);
  });
});
