import { describe, it, expect } from 'vitest';
import { PERSONA_TEMPLATES, getPersonaTemplate, getPersonaIds } from './index';

describe('persona templates', () => {
  it('exports 9 persona templates', () => {
    expect(PERSONA_TEMPLATES).toHaveLength(9);
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

  it('getPersonaTemplate returns correct template by ID', () => {
    const qa = getPersonaTemplate('qa');
    expect(qa).toBeDefined();
    expect(qa!.name).toBe('Quality Assurance');
    expect(qa!.content).toContain('QA reviewer');
  });

  it('getPersonaTemplate returns undefined for unknown ID', () => {
    expect(getPersonaTemplate('nonexistent')).toBeUndefined();
  });

  it('getPersonaIds returns all 9 IDs', () => {
    const ids = getPersonaIds();
    expect(ids).toHaveLength(9);
    expect(ids).toContain('project-manager');
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
});
