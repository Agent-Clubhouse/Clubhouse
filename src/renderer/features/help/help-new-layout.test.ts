import { describe, it, expect, afterEach } from 'vitest';
import { CHROME_HELP_SECTIONS, getHelpSections } from './help-content';
import { useChromeFlagStore } from '../../chrome/chromeFlag';

describe('The new layout pages (#3889)', () => {
  afterEach(() => useChromeFlagStore.setState({ enabled: false }));
  const find = (id: string) => CHROME_HELP_SECTIONS.flatMap((s) => s.topics).find((t) => t.id === id)!.content;
  const EDITED = ['getting-started', 'navigation', 'keyboard-shortcuts', 'agents-overview', 'agents-quick', 'agents-durable'];

  it('describes the sidebar, Needs you and the classic layout as they ship', () => {
    const nav = find('navigation');
    for (const part of [
      '**Show**', '**All computers**', '**Filter projects and agents**', '**Search everything**', '**More app views**', 'The **Dispatcher**, above every project',
      '## Needs you', '**Order**', '**Collapse all projects**', '**Pin to top**', '**Keep open**', '**Merge with…**', '**Split per computer**',
      '`⌥⌘D`', '**Pop back in**', '**Classic layout**', 'will go away in a future update',
    ]) expect(nav, part).toContain(part);
    expect(nav).not.toMatch(/\*\*Host\*\*|satellite|\*\*Search\*\* opens/);
  });

  it('fixes what the agent pages said about the CLI, the row menu, dragging and New agent', () => {
    expect(find('agents-overview')).not.toMatch(/runs on an orchestrator|project's orchestrator|can't be dragged/);
    expect(find('agents-overview')).toContain('**Wake with a fresh session**');
    expect(find('agents-durable')).not.toContain('Start New Session');
    expect(find('agents-quick')).not.toContain('**New Quick Agent** dialog');
    expect(find('agents-quick')).toContain('**Task**, what it should do');
    expect(find('agents-durable')).not.toContain('Use git worktree');
    expect(find('agents-durable')).toContain('**Own worktree and branch**');
    expect(find('agents-durable')).toContain('**Quick agent defaults**');
    expect(find('keyboard-shortcuts')).toContain('`⌥⌘↑` and `⌥⌘↓`');
  });

  it('links only to topics the new layout has, without em dashes', () => {
    useChromeFlagStore.setState({ enabled: true });
    const ids = new Set(getHelpSections().flatMap((s) => s.topics.map((t) => t.id)));
    for (const id of EDITED) {
      const content = find(id);
      expect(content, id).not.toContain('—');
      for (const m of content.matchAll(/\]\(#help:([a-z0-9-]+)\)/g)) expect(ids.has(m[1]), `${id} links ${m[1]}`).toBe(true);
    }
  });
});
