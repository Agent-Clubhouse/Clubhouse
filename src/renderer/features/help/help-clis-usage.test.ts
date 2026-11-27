import { describe, it, expect, afterEach } from 'vitest';
import { HELP_SECTIONS, NEW_LAYOUT_TOPICS, getHelpSections } from './help-content';
import { useChromeFlagStore } from '../../chrome/chromeFlag';

describe('clis-usage help in the new layout', () => {
  afterEach(() => useChromeFlagStore.setState({ enabled: false }));
  const topic = (id: string) => NEW_LAYOUT_TOPICS.find((n) => n.topic.id === id)!.topic;

  describe('CLIs and usage (#3897)', () => {
    it('follows Antigravity CLI in the agents section', () => {
      useChromeFlagStore.setState({ enabled: true });
      const agents = getHelpSections().find((s) => s.id === 'agents')!.topics.map((t) => t.id);
      expect(agents.indexOf('agents-clis-usage')).toBe(agents.indexOf('agents-antigravity') + 1);
      expect(topic('agents-clis-usage').title).toBe('CLIs and usage');
    });

    it('covers accounts, model and context, changing the CLI, versions and Usage', () => {
      const content = topic('agents-clis-usage').content;
      for (const part of [
        'one account per CLI', '`CLAUDE_CONFIG_DIR`', '`CODEX_HOME`', '`COPILOT_HOME`', '**Check again**', 'Next start: 500K', '**Review Smart routing**',
        "Its conversation can't move to another CLI", '**Change CLI**', '**Settings > Usage**', '**Plan limits**', '**Tokens used**', '**By role**',
        'spends no tokens', '**Settings > Experimental**',
      ]) expect(content, part).toContain(part);
    });
  });

  it('Agents and CLIs no longer names removed flags or API keys', () => {
    const content = HELP_SECTIONS.flatMap((s) => s.topics).find((t) => t.id === 'orchestrators')!.content;
    expect(content).not.toContain('--full-auto');
    expect(content).not.toMatch(/API keys|Green checkmark/);
    expect(content).toContain('**GitHub Copilot CLI**');
  });
});
