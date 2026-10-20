import { describe, it, expect } from 'vitest';
import { PERSONA_TEMPLATES, getPersonaTemplate, getPersonaIds } from './index';
import { PATTERN_SETTING_KEYS, parsePersonaFile, stripPersonaFrontMatter } from '../../../shared/persona-pattern';

describe('persona templates', () => {
  it('exports 12 persona templates', () => {
    expect(PERSONA_TEMPLATES).toHaveLength(12);
  });

  it('each template has required fields', () => {
    for (const persona of PERSONA_TEMPLATES) {
      expect(persona.id).toBeTruthy();
      expect(persona.name).toBeTruthy();
      expect(persona.description).toBeTruthy();
      expect(persona.content).toBeTruthy();
      expect(persona.content.length).toBeGreaterThan(100);
    }
  });

  it('each template has focused tooling and skills', () => {
    // Helpers run on whatever CLI their orchestrator picks, so the helper
    // personas name none. Every other persona prefers Claude.
    const anyCli = new Set(['orchestrator', 'workhorse']);
    for (const persona of PERSONA_TEMPLATES) {
      expect(persona.tools).toBeDefined();
      expect(Array.isArray(persona.tools)).toBe(true);
      expect(persona.orchestrator, persona.id).toBe(anyCli.has(persona.id) ? undefined : 'claude');
      expect(Array.isArray(persona.skills)).toBe(true);
    }
  });

  it('group-project-pm has only board management tools', () => {
    const pm = getPersonaTemplate('group-project-pm');
    expect(pm!.tools).toContain('read_bulletin');
    expect(pm!.tools).toContain('post_bulletin');
    expect(pm!.tools).toContain('wake_agent');
    expect(pm!.tools).not.toContain('build');
    expect(pm!.tools).not.toContain('test');
    expect(pm!.tools).not.toContain('create-pr');
  });

  it('executors have only implementation tools', () => {
    const executor = getPersonaTemplate('executor-pr-only');
    expect(executor!.tools).toContain('build');
    expect(executor!.tools).toContain('test');
    expect(executor!.tools).toContain('create-pr');
    expect(executor!.tools).not.toContain('read_bulletin');
    expect(executor!.tools).not.toContain('wake_agent');
  });

  it('qa has testing and review tools', () => {
    const qa = getPersonaTemplate('qa');
    expect(qa!.tools).toContain('test');
    expect(qa!.tools).toContain('code-review');
    expect(qa!.skills!.map((s) => s.name)).toContain('validate-changes');
  });

  it('researcher has web search and investigation tools', () => {
    const researcher = getPersonaTemplate('researcher');
    expect(researcher!.tools).toContain('web-search');
    expect(researcher!.tools).toContain('web-fetch');
    expect(researcher!.skills!.map((s) => s.name)).toContain('deep-research');
  });

  it('getPersonaTemplate returns correct template by ID', () => {
    const qa = getPersonaTemplate('qa');
    expect(qa).toBeDefined();
    expect(qa!.name).toBe('Quality Assurance');
    expect(qa!.content).toContain('QA reviewer');
  });

  it('getPersonaTemplate returns undefined for unknown ID', () => {
    expect(getPersonaTemplate('nonexistent')).toBeUndefined();
  });

  it('getPersonaIds returns all 12 IDs', () => {
    const ids = getPersonaIds();
    expect(ids).toHaveLength(12);
    expect(ids).toContain('project-manager');
    expect(ids).toContain('group-project-pm');
    expect(ids).toContain('qa');
    expect(ids).toContain('ui-lead');
    expect(ids).toContain('quality-auditor');
    expect(ids).toContain('executor-pr-only');
    expect(ids).toContain('executor-merge');
    expect(ids).toContain('doc-updater');
    expect(ids).toContain('judge');
    expect(ids).toContain('researcher');
    expect(ids).toContain('orchestrator');
    expect(ids).toContain('workhorse');
  });

  it('all templates have unique IDs', () => {
    const ids = PERSONA_TEMPLATES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('group-project-pm persona includes skills bundling', () => {
    const pm = getPersonaTemplate('group-project-pm');
    expect(pm).toBeDefined();
    expect(pm!.skills).toBeDefined();
    expect(pm!.skills).toHaveLength(1);
    expect(pm!.skills![0].name).toBe('group-pm-polling');
    expect(pm!.skills![0].cadence).toBe('15m');
  });

  describe('orchestrated helpers (#2233)', () => {
    const orchestrator = () => getPersonaTemplate('orchestrator')!;
    const workhorse = () => getPersonaTemplate('workhorse')!;

    it('loads the Orchestrator and Workhorse personas', () => {
      expect(orchestrator().name).toBe('Orchestrator');
      expect(workhorse().name).toBe('Workhorse');
      // Neither is tied to one CLI: helpers run on whatever the orchestrator picks.
      expect(orchestrator().orchestrator).toBeUndefined();
      expect(workhorse().orchestrator).toBeUndefined();
    });

    it('carries the orchestration policy in the Orchestrator front-matter', () => {
      const match = orchestrator().content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
      expect(match).not.toBeNull();
      const line = match![1].split(/\r?\n/).find((l) => l.startsWith('orchestration:'))!;
      expect(JSON.parse(line.slice('orchestration:'.length))).toEqual({ orchestrate: true });
    });

    it('parses the orchestration defaults and nothing else', () => {
      const { settings, body } = parsePersonaFile(orchestrator().content);
      // orchestration is read live by the policy and isn't a pattern setting,
      // so applying the persona copies nothing onto the agent.
      expect(settings).toEqual({ orchestration: { orchestrate: true } });
      expect(PATTERN_SETTING_KEYS as string[]).not.toContain('orchestration');
      expect(body.startsWith('# Orchestrator')).toBe(true);
      expect(stripPersonaFrontMatter(orchestrator().content)).toBe(body);
      expect(body).not.toContain('orchestration:');
    });

    it('describes every orchestration tool by name', () => {
      const body = stripPersonaFrontMatter(orchestrator().content);
      for (const tool of [
        'start_helper', 'list_helpers', 'sleep_helper', 'wake_helper', 'message_parent', 'answer_helper_question', 'hand_off', 'dispose_helper',
        'create_group_project', 'add_to_group_project', 'remove_from_group_project', 'connect_agents', 'disconnect_agents',
      ]) {
        expect(body, tool).toContain(`\`${tool}\``);
      }
    });

    it('tells helpers to push their work and report through message_parent', () => {
      const body = workhorse().content;
      expect(parsePersonaFile(body).body).toBe(body);
      expect(body).toContain('`message_parent`');
      expect(body).toMatch(/push/i);
    });

    it('keeps the copy free of em dashes', () => {
      for (const p of [orchestrator(), workhorse()]) expect(p.content, p.id).not.toContain('\u2014');
    });
  });
});
