import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ClaudeCodeProvider } from '../../orchestrators/claude-code-provider';
import { CodexCliProvider } from '../../orchestrators/codex-cli-provider';
import { CopilotCliProvider } from '../../orchestrators/copilot-cli-provider';
import { DISPATCHER_ROLES } from '../../../shared/dispatcher-behavior';
import {
  DISPATCHER_SKILLS, dispatcherSkills, instructionsWithSkills, parseSkill, skillFile, skillsSection, writeDispatcherSkills,
} from './dispatcher-skills';
import { DISPATCHER_CHAT_INSTRUCTIONS, DISPATCHER_INSTRUCTIONS } from './dispatcher-service';

/**
 * The Dispatcher's built-in skills (#3051) load on every provider: each is
 * written where that CLI reads skills, and the instructions list each one
 * with its file, so a CLI that doesn't load skills from the folder still
 * finds it. Real providers' conventions, no CLI run.
 */

const PROVIDERS = [new ClaudeCodeProvider(), new CodexCliProvider(), new CopilotCliProvider()];
const ALL_CONVENTIONS = PROVIDERS.map((p) => p.conventions);
const SKILLS_DIR = path.join(__dirname, 'skills');
const BASE = { chat: DISPATCHER_CHAT_INSTRUCTIONS, work: DISPATCHER_INSTRUCTIONS } as const;

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatcher-skills-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('the skills Clubhouse ships', () => {
  it('are every SKILL.md in skills/, each under its role, named as its folder', () => {
    const onDisk = DISPATCHER_ROLES.flatMap((role) => fs.readdirSync(path.join(SKILLS_DIR, role)).map((name) => `${role}/${name}`)).sort();
    expect(DISPATCHER_SKILLS.map((s) => `${s.role}/${s.name}`).sort()).toEqual(onDisk);
    for (const skill of DISPATCHER_SKILLS) {
      expect(fs.readFileSync(path.join(SKILLS_DIR, skill.role, skill.name, 'SKILL.md'), 'utf-8')).toBe(skill.text);
      expect(skill.name).toMatch(/^[a-z][a-z-]*$/);
      expect(skill.description.length, skill.name).toBeLessThanOrEqual(250);
    }
    expect(new Set(DISPATCHER_SKILLS.map((s) => s.name)).size).toBe(DISPATCHER_SKILLS.length);
  });

  it('cover the procedures the instructions hand off to them', () => {
    expect(dispatcherSkills('work').map((s) => s.name).sort()).toEqual(['agent-cards', 'check-ins', 'delegating-work', 'memory-upkeep', 'passing-on-news']);
    expect(dispatcherSkills('chat').map((s) => s.name).sort()).toEqual(['catching-up', 'what-else-can-you-do']);
    // Every skill an agent's instructions name is one that agent gets.
    for (const role of DISPATCHER_ROLES) {
      const named = [...BASE[role].matchAll(/`([a-z-]+)` skill/g)].map((m) => m[1]);
      expect(named.length, role).toBeGreaterThan(0);
      for (const name of named) expect(dispatcherSkills(role).map((s) => s.name), `${role}: ${name}`).toContain(name);
    }
  });

  it('delivers managed-agent, shared-edit and interruption safeguards alongside routing guidance (#2583)', async () => {
    const provider = new CopilotCliProvider();
    await writeDispatcherSkills(dir, 'work', provider.conventions);
    await provider.writeInstructions(dir, instructionsWithSkills(DISPATCHER_INSTRUCTIONS, 'work', provider.conventions));
    const instructions = await provider.readInstructions(dir);
    const delegation = fs.readFileSync(path.join(dir, skillFile(provider.conventions, 'delegating-work')), 'utf-8');

    expect(instructions).toContain('`create_managed_agent` creates an agent in a project; it starts asleep');
    expect(delegation).toContain('Before creation, read `list_agent_templates` if using a template');
    expect(delegation).toContain('Confirm the template and effective CLI, model, access and orchestration with the user');
    expect(delegation).toContain('Do not silently substitute a template\'s CLI for the user\'s choice');
    expect(delegation).toContain('Creating an asleep agent and waking it are separate choices: start it only when requested');
    expect(instructions).toContain('Check `connectedToDispatcher` and its receipt');
    expect(instructions).toContain('`list_agents` shows the agents connected to you');
    expect(instructions).toContain('When a tool refuses for lack of permission, stop and tell the user');
    expect(instructions).toContain('A shared edit or deletion first answers with who it affects; show that preview and ask the user before committing with its `confirm` token');
    expect(instructions).toContain('A token is not user approval');
    expect(instructions).toContain('`now: true` cuts off a turn: ask first unless losing it is already acceptable, as with forced sleep');
    expect(instructions).toContain('pass `force` only when losing that turn is fine, and ask the user if you aren\'t sure');
    expect(instructions).not.toContain('You don\'t create projects, agents or connections');
  });

  it('refuses a SKILL.md without its front matter', () => {
    expect(() => parseSkill('# No front matter', 'work')).toThrow(/front matter/);
    expect(parseSkill('---\nname: x\ndescription: Does x.\n---\n\n# X\n', 'chat')).toMatchObject({ name: 'x', description: 'Does x.', role: 'chat' });
  });
});

describe.each(PROVIDERS.map((p) => [p.id, p] as const))('on %s', (_id, provider) => {
  it.each(DISPATCHER_ROLES)('the %s agent gets its skills where the CLI reads them, and its instructions list each file', async (role) => {
    await writeDispatcherSkills(dir, role, provider.conventions, ALL_CONVENTIONS);
    const instructions = instructionsWithSkills(BASE[role], role, provider.conventions);
    expect(instructions.startsWith(BASE[role])).toBe(true);
    for (const skill of dispatcherSkills(role)) {
      const rel = skillFile(provider.conventions, skill.name);
      expect(fs.readFileSync(path.join(dir, rel), 'utf-8')).toBe(skill.text);
      expect(instructions).toContain(`\`${skill.name}\` (\`${rel}\`): ${skill.description}`);
    }
    // The section lists only files that exist.
    for (const [, rel] of skillsSection(role, provider.conventions).matchAll(/\(`([^`]+)`\)/g)) expect(fs.existsSync(path.join(dir, rel)), rel).toBe(true);
  });
});

describe('writeDispatcherSkills', () => {
  const claude = new ClaudeCodeProvider().conventions;

  it('replaces an older version\'s text and removes skills no longer shipped, and nothing else', async () => {
    const root = path.join(dir, '.claude', 'skills');
    fs.mkdirSync(path.join(root, 'retired'), { recursive: true });
    fs.mkdirSync(path.join(root, 'check-ins'), { recursive: true });
    fs.writeFileSync(path.join(root, 'check-ins', 'SKILL.md'), 'old');
    fs.writeFileSync(path.join(root, 'check-ins', 'extra.md'), 'a file the skill no longer has');
    fs.mkdirSync(path.join(root, 'theirs'), { recursive: true });
    fs.writeFileSync(path.join(root, '.clubhouse-managed-skills.json'), JSON.stringify({ skills: ['retired', 'check-ins'] }));
    await writeDispatcherSkills(dir, 'work', claude, ALL_CONVENTIONS);
    expect(fs.existsSync(path.join(root, 'retired'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'check-ins', 'extra.md'))).toBe(false);
    expect(fs.readFileSync(path.join(root, 'check-ins', 'SKILL.md'), 'utf-8')).toContain('# Check-ins');
    expect(fs.existsSync(path.join(root, 'theirs'))).toBe(true);
  });

  it('never removes anything outside the skills folder a manifest names', async () => {
    const outside = path.join(dir, 'keep');
    fs.mkdirSync(outside);
    const root = path.join(dir, '.claude', 'skills');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, '.clubhouse-managed-skills.json'), JSON.stringify({ skills: ['../../keep', '..', '.', '', 7] }));
    await writeDispatcherSkills(dir, 'work', claude, ALL_CONVENTIONS);
    expect(fs.existsSync(outside)).toBe(true);
  });

  it('takes the skills out of every other CLI\'s folder, including one a CLI used before', async () => {
    const codex = new CodexCliProvider().conventions;
    await writeDispatcherSkills(dir, 'work', { ...codex, skillsRoot: '.codex/skills' }, ALL_CONVENTIONS);
    await writeDispatcherSkills(dir, 'work', codex, ALL_CONVENTIONS);
    expect(fs.existsSync(path.join(dir, '.codex', 'skills', 'delegating-work'))).toBe(false);
    expect(fs.existsSync(path.join(dir, '.codex', 'skills', '.clubhouse-managed-skills.json'))).toBe(false);
    await writeDispatcherSkills(dir, 'work', new CopilotCliProvider().conventions, ALL_CONVENTIONS);
    expect(fs.existsSync(path.join(dir, '.agents', 'skills', 'delegating-work'))).toBe(false);
    expect(fs.existsSync(path.join(dir, '.github', 'skills', 'delegating-work', 'SKILL.md'))).toBe(true);
  });
});
