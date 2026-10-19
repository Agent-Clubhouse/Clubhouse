import { describe, it, expect } from 'vitest';
import { PERSONA_TEMPLATES, canonicalPersonaId, getPersonaTemplate, getPersonaIds, personaDescription } from './index';
import { PATTERN_SETTING_KEYS, parsePersonaFile, stripPersonaFrontMatter } from '../../../shared/persona-pattern';

const EXPECTED_NAMES: Record<string, string> = {
  'project-manager': 'Project Manager',
  qa: 'PR Reviewer',
  'ui-lead': 'Design Lead',
  'quality-auditor': 'AI Slop Detector',
  'executor-pr-only': 'Developer, opens PRs',
  'executor-merge': 'Developer, can merge',
  'doc-updater': 'Docs Writer',
  judge: 'Solution Judge',
  researcher: 'Researcher',
  orchestrator: 'Orchestrator',
  workhorse: 'Workhorse',
};

const words = (text: string) => text.split(/\s+/).filter(Boolean).length;

describe('persona templates', () => {
  it('lists every persona under its display name, ids unchanged', () => {
    expect(getPersonaIds()).toEqual(Object.keys(EXPECTED_NAMES));
    for (const [id, name] of Object.entries(EXPECTED_NAMES)) {
      expect(getPersonaTemplate(id)?.name, id).toBe(name);
    }
  });

  it('loads a body and a one-line description for every listed persona', () => {
    for (const persona of PERSONA_TEMPLATES) {
      const body = stripPersonaFrontMatter(persona.content);
      expect(body.startsWith(`# ${persona.name}`), persona.id).toBe(true);
      expect(words(body), persona.id).toBeGreaterThanOrEqual(250);
      expect(words(body), persona.id).toBeLessThanOrEqual(650);
      expect(persona.description.length, persona.id).toBeGreaterThan(40);
      expect(persona.description, persona.id).not.toContain('\n');
      expect(personaDescription(persona.id)).toBe(persona.description);
    }
  });

  it('carries only id, name, description and content', () => {
    for (const persona of PERSONA_TEMPLATES) {
      expect(Object.keys(persona).sort(), persona.id).toEqual(['content', 'description', 'id', 'name']);
    }
  });

  it('keeps the copy free of em and en dashes', () => {
    for (const persona of PERSONA_TEMPLATES) {
      for (const text of [persona.content, persona.description, persona.name]) {
        expect(text, persona.id).not.toMatch(/[–—]/);
      }
    }
  });

  it('keeps the copy free of unsupported conventions', () => {
    for (const persona of PERSONA_TEMPLATES) {
      const body = persona.content;
      // @@ wildcards aren't substituted into an appended persona.
      expect(body, persona.id).not.toContain('@@');
      expect(body, persona.id).not.toMatch(/\bdriver\b/i);
      // Only general, control and inbox channels exist by default.
      expect(body, persona.id).not.toMatch(/`(progress|decisions|blockers|missions-[^`]*)`/);
      // Skills that don't ship to user projects.
      expect(body, persona.id).not.toMatch(/group-pm-polling|deep-research/);
      // No all-caps emphasis or bold labels.
      expect(body, persona.id).not.toMatch(/\b(NOT|NEVER|MUST|ALWAYS|ONLY|CRITICAL)\b/);
      expect(body, persona.id).not.toContain('**');
    }
  });

  it('getPersonaTemplate returns undefined for unknown ID', () => {
    expect(getPersonaTemplate('nonexistent')).toBeUndefined();
    expect(personaDescription('nonexistent')).toBeUndefined();
    expect(personaDescription('')).toBeUndefined();
  });

  describe('merged Project Manager', () => {
    it('resolves the retired group-project-pm id to the Project Manager, unlisted', () => {
      expect(getPersonaIds()).not.toContain('group-project-pm');
      expect(PERSONA_TEMPLATES.some((p) => p.id === 'group-project-pm')).toBe(false);
      expect(canonicalPersonaId('group-project-pm')).toBe('project-manager');
      expect(getPersonaTemplate('group-project-pm')).toBe(getPersonaTemplate('project-manager'));
      expect(personaDescription('group-project-pm')).toBe(getPersonaTemplate('project-manager')!.description);
    });

    it('ties admin tools to the admin role and gives a fallback without them', () => {
      const body = getPersonaTemplate('project-manager')!.content;
      expect(parsePersonaFile(body).body).toBe(body);
      expect(body).toContain('admin role');
      expect(body).toContain('first agent to join');
      expect(body).toContain('`notify_user`');
      for (const tool of ['wake_agent', 'sleep_agent', 'shoulder_tap', 'set_project_info']) {
        expect(body, tool).toContain(`\`${tool}\``);
      }
    });
  });

  describe('orchestrated helpers (#2233)', () => {
    const orchestrator = () => getPersonaTemplate('orchestrator')!;
    const workhorse = () => getPersonaTemplate('workhorse')!;

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

    it('carries no front-matter on any other persona', () => {
      for (const persona of PERSONA_TEMPLATES.filter((p) => p.id !== 'orchestrator')) {
        expect(parsePersonaFile(persona.content).body, persona.id).toBe(persona.content);
      }
    });

    it('describes every orchestration tool by name', () => {
      const body = stripPersonaFrontMatter(orchestrator().content);
      for (const tool of [
        'start_helper', 'list_helpers', 'sleep_helper', 'wake_helper', 'message_parent', 'hand_off', 'dispose_helper',
        'create_group_project', 'add_to_group_project', 'remove_from_group_project', 'connect_agents', 'disconnect_agents',
      ]) {
        expect(body, tool).toContain(`\`${tool}\``);
      }
    });

    it('tells helpers to push their work and report through message_parent', () => {
      const body = workhorse().content;
      expect(body).toContain('`message_parent`');
      expect(body).toMatch(/push/i);
    });
  });
});
