import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  projects: [] as Array<{ id: string; name: string; path: string }>,
  agentOf: 'agent-1' as string | undefined,
  configure: null as string | null,
  configureAsked: [] as string[],
}));

vi.mock('../project-store', () => ({ peekProjects: async () => h.projects }));
vi.mock('./plugin-tool-registry', () => ({ agentOfPluginCall: () => h.agentOf }));
vi.mock('./plugin-caller-check', () => ({
  CALL_OVER: 'over',
  checkPluginCaller: async (_p: string, _c: string, check: { projectPath: string }) => { h.configureAsked.push(check.projectPath); return h.configure; },
}));

import { agentRegistry } from '../agent-registry';
import { checkPluginFileChange } from './plugin-file-check';

// The native realpath, as main uses: on Windows it expands short names (RUNNER~1).
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-file-check-')));
const home = path.join(tmp, 'home');
const other = path.join(tmp, 'other');
const outside = path.join(tmp, 'outside');
for (const d of [path.join(home, '.clubhouse', 'agents', 'ada', 'src'), path.join(home, 'src'), other, outside]) fs.mkdirSync(d, { recursive: true });
// A folder link into .clubhouse: a junction on Windows, which needs no privilege.
let linked = true;
try { fs.symlinkSync(path.join(home, '.clubhouse'), path.join(home, 'innocent'), 'junction'); } catch { linked = false; }

// Links agents read through, and a project registered inside another (#3174 review).
fs.mkdirSync(path.join(home, 'docs'), { recursive: true });
fs.writeFileSync(path.join(home, 'docs', 'guide.md'), 'x');
let fileLinks = true;
try {
  fs.symlinkSync(path.join(home, 'docs', 'guide.md'), path.join(home, 'CLAUDE.md'));
  fs.symlinkSync(path.join(home, 'AGENTS.md'), path.join(home, 'dangling.md'));
} catch { fileLinks = false; }
const nested = path.join(home, 'packages', 'b');
fs.mkdirSync(path.join(nested, '.clubhouse'), { recursive: true });

afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

/** The calling agent runs at `level`, in the home project. */
function runAt(level: 'plan' | 'ask' | 'auto_edit' | 'auto' | 'full_access') {
  agentRegistry.untrack('agent-1');
  agentRegistry.register('agent-1', { projectPath: home, orchestrator: 'claude-code', runtime: 'chat' });
  agentRegistry.setLaunchCap('agent-1', { freeAgentMode: level === 'auto' || level === 'full_access', access: level });
}

const check = (p: string, op: 'write' | 'delete' | 'exec' = 'write') => checkPluginFileChange('plugin', 'call', p, op);

beforeEach(() => {
  h.projects = [{ id: 'h', name: 'Home', path: home }, { id: 'o', name: 'Other', path: other }];
  h.agentOf = 'agent-1';
  h.configure = null;
  h.configureAsked = [];
  runAt('auto_edit');
});

describe('a file a plugin changes for an agent, judged in main (D126, #3174)', () => {
  it('an ordinary file in its own project is an edit: Auto-accept edits', async () => {
    expect(await check(path.join(home, 'src', 'a.ts'))).toBeNull();
    runAt('ask');
    expect(await check(path.join(home, 'src', 'a.ts'))).toMatch(/runs at Ask first, so a plugin can't change files there for it: that acts at Auto-accept edits/);
  });

  it('Clubhouse\'s own records are refused, whatever the case or a trailing dot, or a symlink to them', async () => {
    runAt('full_access');
    for (const p of [
      path.join(home, '.clubhouse', 'agents.json'),
      path.join(home, '.CLUBHOUSE', 'settings.json'),
      path.join(home, '.clubhouse.', 'settings.json'),
      ...(linked ? [path.join(home, 'innocent', 'agents.json')] : []),
    ]) {
      expect(await check(p), p).toMatch(/Clubhouse's own record/);
    }
  });

  it('the whole project, or an agent\'s whole worktree, is refused', async () => {
    runAt('full_access');
    expect(await check(home, 'delete')).toMatch(/whole project/);
    expect(await check(path.join(home, '.clubhouse', 'agents', 'ada'), 'delete')).toMatch(/whole project or an agent's whole worktree/);
  });

  it('a file in an agent\'s worktree is project code; its configuration is not', async () => {
    expect(await check(path.join(home, '.clubhouse', 'agents', 'ada', 'src', 'a.ts'))).toBeNull();
    h.configure = 'no project.configure';
    expect(await check(path.join(home, '.clubhouse', 'agents', 'ada', '.claude', 'settings.local.json'))).toBe('no project.configure');
    expect(h.configureAsked).toEqual([home]);
  });

  it('what agents read as configuration needs project.configure, by any case', async () => {
    h.configure = 'no project.configure';
    for (const p of ['.claude/settings.local.json', '.mcp.json', '.codex/config.toml', '.GIT/hooks/pre-commit', 'CLAUDE.md', 'Agents.md', '.github/mcp.json']) {
      expect(await check(path.join(home, p)), p).toBe('no project.configure');
    }
    h.configure = null;
    expect(await check(path.join(home, '.claude', 'settings.local.json'))).toBeNull();
  });

  it('another project only at Full access, and outside every project only at Full access', async () => {
    expect(await check(path.join(other, 'a.ts'))).toMatch(/another project than the calling agent's/);
    expect(await check(path.join(outside, 'a.ts'))).toMatch(/acts at Full access/);
    runAt('full_access');
    expect(await check(path.join(other, 'a.ts'))).toBeNull();
    expect(await check(path.join(outside, 'a.ts'))).toBeNull();
  });

  it('a command runs at Auto, in its own project', async () => {
    expect(await check(home, 'exec')).toMatch(/can't run a command there for it: that acts at Auto/);
    runAt('auto');
    expect(await check(home, 'exec')).toBeNull();
    expect(await check(other, 'exec')).toMatch(/another project/);
  });

  it('a link is judged where it sits and where it leads: a config name linked elsewhere, or a dangling link to one', async () => {
    if (!fileLinks) return;
    h.configure = 'no project.configure';
    // CLAUDE.md links to an ordinary file: writing or deleting it is still a config change.
    expect(await check(path.join(home, 'CLAUDE.md'))).toBe('no project.configure');
    expect(await check(path.join(home, 'CLAUDE.md'), 'delete')).toBe('no project.configure');
    // dangling.md points at AGENTS.md, which doesn't exist yet: a write would create it.
    expect(await check(path.join(home, 'dangling.md'))).toBe('no project.configure');
    // Deleting the dangling link removes only the link: an ordinary edit.
    h.configure = null;
    expect(await check(path.join(home, 'dangling.md'), 'delete')).toBeNull();
  });

  it('a folder holding another project can\'t be deleted, moved or copied onto through its parent', async () => {
    h.projects = [...h.projects, { id: 'b', name: 'B', path: nested }];
    runAt('full_access');
    expect(await check(path.join(home, 'packages'), 'delete')).toMatch(/holds another project/);
    expect(await check(path.join(home, 'packages'))).toMatch(/holds another project/);
    expect(await check(path.join(nested, '.clubhouse', 'agents.json'))).toMatch(/Clubhouse's own record/);
    // A file beside it is fine.
    expect(await check(path.join(home, 'packages', 'README.md'))).toBeNull();
  });

  it('a stream or short name, or a lookalike letter, is no way around it', async () => {
    runAt('full_access');
    expect(await check(path.join(home, 'CLAUDE2.md::$DATA'))).toMatch(/file stream or a short name/);
    expect(await check(path.join(home, 'src', 'a.ts:hidden'))).toMatch(/file stream or a short name/);
    h.configure = 'no project.configure';
    expect(await check(path.join(home, 'AGENT\u017f.md'))).toBe('no project.configure');
    expect(await check(path.join(home, '.g\u0131thub', 'mcp.json'))).toBe('no project.configure');
  });

  it('a call that is over is refused', async () => {
    h.agentOf = undefined;
    expect(await check(path.join(home, 'src', 'a.ts'))).toBe('over');
  });
});
