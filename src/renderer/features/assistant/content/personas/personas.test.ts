import { describe, it, expect } from 'vitest';
import { PERSONA_TEMPLATES, getPersonaTemplate, getPersonaIds } from './index';

describe('persona templates', () => {
  it('exports 10 persona templates', () => {
    expect(PERSONA_TEMPLATES).toHaveLength(10);
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
    for (const persona of PERSONA_TEMPLATES) {
      expect(persona.tools).toBeDefined();
      expect(Array.isArray(persona.tools)).toBe(true);
      expect(persona.orchestrator).toBe('claude');
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

  it('getPersonaIds returns all 10 IDs', () => {
    const ids = getPersonaIds();
    expect(ids).toHaveLength(10);
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
});
