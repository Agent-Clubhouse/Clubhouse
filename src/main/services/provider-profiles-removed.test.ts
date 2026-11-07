import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const W = vi.hoisted(() => ({
  userData: '',
  projects: [] as Array<{ id: string; name: string; path: string; displayName?: string }>,
  defaults: new Map<string, Record<string, unknown>>(),
}));

vi.mock('electron', () => ({ app: { getPath: () => W.userData } }));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('./project-store', () => ({ peekProjects: async () => W.projects }));
vi.mock('./agent-settings-service', () => ({ readProjectAgentDefaults: async (p: string) => W.defaults.get(p) ?? {} }));

import { appLog } from './log-service';
import { noteRemovedProviderProfiles } from './provider-profiles-removed';

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
