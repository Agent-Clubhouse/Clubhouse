import * as fs from 'node:fs';
import * as nodeOs from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DurableAgentConfig, ProjectAgentDefaults } from '../../../shared/types';

const h = vi.hoisted(() => ({
  home: '',
  defaults: {} as ProjectAgentDefaults,
  defaultsFail: false,
}));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => h.home, default: { ...actual, homedir: () => h.home } };
});
vi.mock('../log-service', () => ({ appLog: vi.fn() }));
vi.mock('../agent-settings-service', () => ({
  readProjectAgentDefaults: vi.fn(async () => {
    if (h.defaultsFail) throw new Error('unreadable');
    return h.defaults;
  }),
}));

import { appLog } from '../log-service';
import { legacyPersonaBody, legacyPersonaId, legacyPersonaOrchestration, orchestrationToCarry } from './legacy-migration';

let root: string;
let project: string;

function agent(extra: Partial<DurableAgentConfig> = {}): DurableAgentConfig {
  return { id: 'a1', name: 'ada', color: 'indigo', createdAt: '2026-11-07T00:00:00.000Z', ...extra };
}

function writePersona(dir: string, id: string, content: string): void {
  fs.mkdirSync(path.join(dir, '.clubhouse', 'personas'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.clubhouse', 'personas', `${id}.md`), content);
}

const withPolicy = (policy: Record<string, unknown>, body = '# Persona\n') => `---\norchestration: ${JSON.stringify(policy)}\n---\n\n${body}`;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(nodeOs.tmpdir(), 'legacy-migration-'));
  project = path.join(root, 'project');
  h.home = path.join(root, 'home');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(h.home, { recursive: true });
  h.defaults = {};
  h.defaultsFail = false;
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('legacyPersonaId', () => {
  it('is the agent\'s own persona, else the project default, else none', async () => {
    h.defaults = { persona: 'qa' };
    expect(await legacyPersonaId(project, agent({ persona: 'judge' }))).toBe('judge');
    expect(await legacyPersonaId(project, agent())).toBe('qa');
    h.defaults = {};
    expect(await legacyPersonaId(project, agent())).toBeUndefined();
  });

  it('reads unreadable project defaults as no default', async () => {
    h.defaultsFail = true;
    expect(await legacyPersonaId(project, agent())).toBeUndefined();
    expect(await legacyPersonaId(project, agent({ persona: 'qa' }))).toBe('qa');
  });
});

describe('legacyPersonaBody', () => {
  it('looks in the project, then the user\'s folder, then the built-in text, without front matter', async () => {
    expect(await legacyPersonaBody(project, 'qa')).toContain('# Role: Quality Assurance');
    writePersona(h.home, 'qa', withPolicy({ maxHelpers: 2 }, 'User QA.\n'));
    expect(await legacyPersonaBody(project, 'qa')).toBe('User QA.\n');
    writePersona(project, 'qa', withPolicy({ maxHelpers: 3 }, 'Project QA.\n'));
    expect(await legacyPersonaBody(project, 'qa')).toBe('Project QA.\n');
  });

  it('is undefined for no id, an unknown id or a name that leaves the personas folder', async () => {
    expect(await legacyPersonaBody(project, undefined)).toBeUndefined();
    expect(await legacyPersonaBody(project, 'pirate')).toBeUndefined();
    fs.mkdirSync(path.join(project, '.clubhouse'), { recursive: true });
    fs.writeFileSync(path.join(project, '.clubhouse', 'secret.md'), 'Secret.');
    for (const id of [path.join('..', 'secret'), '../secret', '..\\secret', '..', '', 'a\0b']) {
      expect(await legacyPersonaBody(project, id), JSON.stringify(id)).toBeUndefined();
    }
  });

  it('logs a skipped id with its code only', async () => {
    vi.mocked(appLog).mockClear();
    expect(await legacyPersonaBody(project, '../secret-name')).toBeUndefined();
    expect(appLog).toHaveBeenCalledWith('core:managed', 'warn', expect.any(String), { meta: { code: 'invalid_persona_id' } });
    expect(JSON.stringify(vi.mocked(appLog).mock.calls)).not.toContain('secret-name');
  });

  it('keeps the dropped built-ins\' text for a switch, though they are no blocks', async () => {
    expect(await legacyPersonaBody(project, 'ui-lead')).toContain('# Role: UI/Design Lead');
    expect(await legacyPersonaBody(project, 'quality-auditor')).toContain('# Role: Quality Auditor');
    expect(await legacyPersonaBody(project, 'doc-updater')).toContain('# Role: Documentation Updater');
    writePersona(project, 'ui-lead', 'Our UI lead.\n');
    expect(await legacyPersonaBody(project, 'ui-lead')).toBe('Our UI lead.\n');
  });

  it('finds nothing for an inherited object key', async () => {
    for (const id of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(await legacyPersonaBody(project, id), id).toBeUndefined();
      expect(await legacyPersonaOrchestration(project, agent({ persona: id })), id).toBeUndefined();
    }
  });

  it('reads an id the persona runtime read, spaces and all', async () => {
    writePersona(project, 'My Reviewer', withPolicy({ maxHelpers: 2 }, 'Review with care.\n'));
    expect(await legacyPersonaBody(project, 'My Reviewer')).toBe('Review with care.\n');
    expect(await legacyPersonaOrchestration(project, agent({ persona: 'My Reviewer' }))).toEqual({ maxHelpers: 2 });
  });
});

describe('legacyPersonaOrchestration', () => {
  it('takes the agent\'s own persona front matter', async () => {
    writePersona(project, 'lead', withPolicy({ orchestrate: true, control: 'ask-before-start', connectToDispatcher: true }));
    expect(await legacyPersonaOrchestration(project, agent({ persona: 'lead' }))).toEqual({ orchestrate: true, control: 'ask-before-start', connectToDispatcher: true });
  });

  it('layers the project orchestrator.md under another persona, without its orchestrate or connectToDispatcher', async () => {
    writePersona(project, 'orchestrator', withPolicy({ orchestrate: true, connectToDispatcher: true, maxHelpers: 2, access: 'standard' }));
    writePersona(project, 'dev', withPolicy({ access: 'same' }));
    expect(await legacyPersonaOrchestration(project, agent({ persona: 'dev' }))).toEqual({ maxHelpers: 2, access: 'same' });
    expect(await legacyPersonaOrchestration(project, agent())).toEqual({ maxHelpers: 2, access: 'standard' });
    expect(await legacyPersonaOrchestration(project, agent({ persona: 'orchestrator' }))).toEqual({ orchestrate: true, connectToDispatcher: true, maxHelpers: 2, access: 'standard' });
  });

  it('follows the project default persona and the user\'s orchestrator.md', async () => {
    writePersona(h.home, 'orchestrator', withPolicy({ maxHelpers: 4 }));
    h.defaults = { persona: 'orchestrator' };
    expect(await legacyPersonaOrchestration(project, agent())).toEqual({ maxHelpers: 4 });
  });

  it('gives the built-in Orchestrator orchestrate: true, and only to agents that use it', async () => {
    expect(await legacyPersonaOrchestration(project, agent({ persona: 'orchestrator' }))).toEqual({ orchestrate: true });
    expect(await legacyPersonaOrchestration(project, agent({ persona: 'workhorse' }))).toBeUndefined();
    expect(await legacyPersonaOrchestration(project, agent())).toBeUndefined();
  });

  it('drops a persona\'s autoHelpers: true, and keeps its false', async () => {
    writePersona(project, 'on', withPolicy({ autoHelpers: true, maxHelpers: 3 }));
    writePersona(project, 'off', withPolicy({ autoHelpers: false }));
    expect(await legacyPersonaOrchestration(project, agent({ persona: 'on' }))).toEqual({ maxHelpers: 3 });
    expect(await legacyPersonaOrchestration(project, agent({ persona: 'off' }))).toEqual({ autoHelpers: false });
  });

  it('is undefined for a managed agent', async () => {
    writePersona(project, 'lead', withPolicy({ orchestrate: true }));
    const managed = { version: 1 as const, blocks: [], skills: [], mcps: [] };
    expect(await legacyPersonaOrchestration(project, agent({ persona: 'lead', managed }))).toBeUndefined();
  });
});

describe('orchestrationToCarry', () => {
  it('is what the layer set and the agent didn\'t', () => {
    expect(orchestrationToCarry({ access: 'same' }, { access: 'standard', maxHelpers: 2, orchestrate: true })).toEqual({ maxHelpers: 2, orchestrate: true });
    expect(orchestrationToCarry(undefined, { orchestrate: true })).toEqual({ orchestrate: true });
  });

  it('carries a persona\'s Auto off over the agent\'s own on, as the old rule had it (#2671)', () => {
    expect(orchestrationToCarry({ autoHelpers: true, orchestrate: true }, { autoHelpers: false })).toEqual({ autoHelpers: false });
    expect(orchestrationToCarry({ autoHelpers: false }, { autoHelpers: false })).toBeUndefined();
    expect(orchestrationToCarry(undefined, { autoHelpers: false })).toEqual({ autoHelpers: false });
  });

  it('is undefined when the layer decides nothing the agent left open', () => {
    expect(orchestrationToCarry({ orchestrate: false }, undefined)).toBeUndefined();
    expect(orchestrationToCarry({ orchestrate: false }, { orchestrate: true })).toBeUndefined();
    expect(orchestrationToCarry(undefined, {})).toBeUndefined();
  });
});
