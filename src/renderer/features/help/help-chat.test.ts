import { describe, it, expect, afterEach } from 'vitest';
import { CHROME_HELP_SECTIONS, NEW_LAYOUT_TOPICS, getHelpSections } from './help-content';
import { useChromeFlagStore } from '../../chrome/chromeFlag';

describe('chat help in the new layout', () => {
  afterEach(() => useChromeFlagStore.setState({ enabled: false }));
  const topic = (id: string) => NEW_LAYOUT_TOPICS.find((n) => n.topic.id === id)!.topic;

  describe('Chat and media (#3890)', () => {
    it('follows Agents, and CLI and transcripts links to it', () => {
      useChromeFlagStore.setState({ enabled: true });
      const agents = getHelpSections().find((s) => s.id === 'agents')!.topics.map((t) => t.id);
      expect(agents.indexOf('agents-chat')).toBe(agents.indexOf('agents-overview') + 1);
      expect(topic('agents-chat').title).toBe('Chat and media');
      const terminal = CHROME_HELP_SECTIONS.flatMap((s) => s.topics).find((t) => t.id === 'agents-terminal')!.content;
      expect(terminal).toContain('](#help:agents-chat)');
    });

    it('says which CLIs offer chat and how to switch', () => {
      const content = topic('agents-chat').content;
      for (const part of ['| Claude Code | Yes |', '| Codex CLI | Yes, in beta |', '| Copilot CLI | Yes, in beta |', '**Chat view**', '**Rich chat content**', '**CLI default**', 'Stop the agent to change it']) {
        expect(content, part).toContain(part);
      }
    });

    it('covers reading, sending, approvals and media with the labels and limits that ship', () => {
      const content = topic('agents-chat').content;
      for (const part of [
        '**Not delivered**', '**Show more**', '**Previous agent message**', '**Next agent message**', '**Latest**', '**Steer**', '**Stop & send**', '**Queue**',
        '**Clear all**', '**Restore saved message**', '**Previous request**', '**Answer here**', 'up to 3.75 MB', 'up to 20 MB', 'up to 10 attachments',
        '**Open in Files**', '**File not found**', '1 GiB', 'Deleting an agent removes its media',
      ]) expect(content, part).toContain(part);
    });
  });
});
