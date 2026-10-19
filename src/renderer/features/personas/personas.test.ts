import { describe, it, expect } from 'vitest';
import { PERSONA_TEMPLATES, canonicalPersonaId, getPersonaTemplate, getPersonaIds, personaDescription } from './index';
import { PATTERN_SETTING_KEYS, parsePersonaFile, stripPersonaFrontMatter } from '../../../shared/persona-pattern';

const EXPECTED_NAMES: Record<string, string> = {
  'group-project-pm': 'Group Project Lead',
  qa: 'PR Reviewer',
  'ui-lead': 'Design Lead',
  'quality-auditor': 'AI Slop Detector',
  'executor-pr-only': 'Developer',
  'executor-merge': 'Developer (merges)',
  'doc-updater': 'Docs Writer',
  researcher: 'Researcher',
  orchestrator: 'Orchestrator',
  workhorse: 'Generalist',
};

const words = (text: string) => text.split(/\s+/).filter(Boolean).length;

// Group Project Lead runs the whole board: orientation, channels, briefs,
// wake and sleep, polling, taps, hygiene, project info and the merge gate.
// Folding it into a 600-word Project Manager cut that depth and users missed
// it, so it gets more room than the rest.
const WORD_CAP: Record<string, number> = { 'group-project-pm': 750 };

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
      expect(words(body), persona.id).toBeLessThanOrEqual(WORD_CAP[persona.id] ?? 600);
      // One sentence that fits the gallery's two-line clamp and the Settings help slot.
      expect(persona.description.length, persona.id).toBeGreaterThan(40);
      expect(persona.description.length, persona.id).toBeLessThanOrEqual(80);
      expect(persona.description.match(/[.!?](\s|$)/g), persona.id).toHaveLength(1);
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

  it('derives sane default agent names from the display names', () => {
    // TemplateConfigDialog slugs persona.name into the default agent name.
    const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '');
    for (const persona of PERSONA_TEMPLATES) expect(slug(persona.name), persona.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(slug(getPersonaTemplate('executor-merge')!.name)).toBe('developer-merges');
    expect(slug(getPersonaTemplate('quality-auditor')!.name)).toBe('ai-slop-detector');
  });

  it('lists the built-in persona ids for start_helper in the Orchestrator', () => {
    const body = getPersonaTemplate('orchestrator')!.content;
    expect(body).toContain('persona id, not its display name');
    // An orchestrator coordinates its own helpers, so a Group Project Lead
    // under it would be a second coordinator. It isn't offered.
    for (const id of getPersonaIds().filter((id) => !['orchestrator', 'group-project-pm'].includes(id))) {
      expect(body, id).toContain(`\`${id}\``);
    }
    expect(body).not.toContain('`group-project-pm`');
  });

  it('getPersonaTemplate returns undefined for unknown ID', () => {
    expect(getPersonaTemplate('nonexistent')).toBeUndefined();
    expect(personaDescription('nonexistent')).toBeUndefined();
    expect(personaDescription('')).toBeUndefined();
  });

  describe('retired personas', () => {
    it('resolves the retired judge id to the PR Reviewer, unlisted', () => {
      expect(getPersonaIds()).not.toContain('judge');
      expect(canonicalPersonaId('judge')).toBe('qa');
      expect(getPersonaTemplate('judge')).toBe(getPersonaTemplate('qa'));
    });

    it('resolves the retired project-manager id to the Group Project Lead, unlisted', () => {
      expect(getPersonaIds()).not.toContain('project-manager');
      expect(PERSONA_TEMPLATES.some((p) => p.id === 'project-manager')).toBe(false);
      expect(canonicalPersonaId('project-manager')).toBe('group-project-pm');
      expect(getPersonaTemplate('project-manager')).toBe(getPersonaTemplate('group-project-pm'));
      expect(personaDescription('project-manager')).toBe(getPersonaTemplate('group-project-pm')!.description);
    });

    it('lists group-project-pm under its own id again', () => {
      expect(getPersonaIds()).toContain('group-project-pm');
      expect(canonicalPersonaId('group-project-pm')).toBe('group-project-pm');
    });
  });

  describe('Group Project Lead', () => {
    const body = () => getPersonaTemplate('group-project-pm')!.content;

    it('ties admin tools to the admin role and gives a fallback without them', () => {
      expect(parsePersonaFile(body()).body).toBe(body());
      expect(body()).toContain('admin role');
      expect(body()).toContain('first agent to join');
      expect(body()).toContain('group project card');
      expect(body()).toContain('`notify_user`');
    });

    it('covers orientation and every board-operating tool', () => {
      for (const tool of [
        'get_project_info', 'list_members', 'read_bulletin', 'read_topic',
        'wake_agent', 'sleep_agent', 'toggle_polling', 'nudge_polling', 'shoulder_tap', 'broadcast',
        'clear_topic', 'delete_messages', 'compact_agent', 'clear_agent', 'set_project_info',
      ]) {
        expect(body(), tool).toContain(`\`${tool}\``);
      }
      for (const channel of ['general', 'control']) expect(body(), channel).toContain(`\`${channel}\``);
    });

    it('gates merges on the PR Reviewer and green CI', () => {
      const gate = body().split('## Merge gate')[1].split('\n## ')[0];
      expect(gate).toContain('Developer (merges)');
      expect(gate).toContain('PR Reviewer');
      expect(gate).toContain('CI is green');
    });

    it('has a done-means section and an example brief', () => {
      expect(body()).toContain('## Done means');
      expect(body()).toContain('## Example brief');
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
