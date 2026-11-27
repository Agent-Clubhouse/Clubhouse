import { describe, it, expect, afterEach } from 'vitest';
import { CHROME_HELP_SECTIONS, NEW_LAYOUT_TOPICS, getHelpSections } from './help-content';
import { useChromeFlagStore } from '../../chrome/chromeFlag';

describe('access help in the new layout', () => {
  afterEach(() => useChromeFlagStore.setState({ enabled: false }));
  const topic = (id: string) => NEW_LAYOUT_TOPICS.find((n) => n.topic.id === id)!.topic;

  describe('Access and Clubhouse permissions (#3895)', () => {
    it('is in the agents section, and Durable agents links to it', () => {
      useChromeFlagStore.setState({ enabled: true });
      const agents = getHelpSections().find((s) => s.id === 'agents')!.topics.map((t) => t.id);
      expect(agents.indexOf('agents-access')).toBe(agents.indexOf('agents-managed') + 1);
      expect(topic('agents-access').title).toBe('Access and Clubhouse permissions');
      const durable = CHROME_HELP_SECTIONS.flatMap((s) => s.topics).find((t) => t.id === 'agents-durable')!.content;
      expect(durable).toContain('](#help:agents-access)');
    });

    it('names the five levels, the default and what each CLI offers', () => {
      const content = topic('agents-access').content;
      for (const level of ['**Plan**', '**Ask first**', '**Auto-accept edits**', '**Auto**', '**Full access**']) expect(content, level).toContain(level);
      expect(content).toContain('**Default access** in **Settings > Agents & CLIs**');
      for (const row of [
        '| Claude Code | All five | All five |',
        '| Codex CLI | All five | Ask first, Auto, Full access |',
        '| Copilot CLI | Plan, Ask first, Auto-accept edits, Full access | Ask first, Full access |',
      ]) expect(content, row).toContain(row);
      expect(content).toContain('nearest lower level');
    });

    it('covers the ceiling, Codex policy, Clubhouse permissions, requests and plugin permissions', () => {
      const content = topic('agents-access').content;
      for (const part of [
        "An agent can't give another agent more access than it runs at", '**Approval policy**', '**Sandbox**', '**Existing level default**',
        '**Off**, **Ask first** or **Allow**', '**Reset to defaults**', '**From its template**', '**Needs you**', 'Requests expire after 24 hours',
        '**Allow** runs that one call when the agent tries again', '](#help:plugins-permissions)', 'not a sandbox',
      ]) expect(content, part).toContain(part);
    });
  });
});
