import { describe, it, expect } from 'vitest';
import { HELP_SECTIONS, CHROME_HELP_SECTIONS } from './help-content';

describe('Smaller refreshes (#3901)', () => {
  const all = () => [...HELP_SECTIONS, ...CHROME_HELP_SECTIONS].flatMap((s) => s.topics);
  const chrome = (id: string) => CHROME_HELP_SECTIONS.flatMap((s) => s.topics).find((t) => t.id === id)!.content;

  it('updates themes, updates, troubleshooting and plugins to what ships', () => {
    expect(chrome('settings-themes')).toContain('**Search themes**');
    expect(chrome('settings-themes')).not.toMatch(/Workshop/);
    const updates = chrome('updates');
    for (const part of ['**Automatic updates**', '**Preview versions**', '**Update ready**', "**Couldn't check**", 'A downloaded update stays ready', 'needs a newer version of your operating system']) {
      expect(updates, part).toContain(part);
    }
    expect(updates).not.toMatch(/Auto-update toggle|What's New\*\*/);
    const trouble = chrome('troubleshooting-common');
    for (const part of ['**Not found**', '**Restart Dispatcher**', '**Dispatcher debug view**', '**Failed**', '](#help:settings-annex)']) expect(trouble, part).toContain(part);
    expect(trouble).not.toMatch(/CLI view|switch says \*\*CLI not found\*\*|satellite|\*\*Local\*\*/);
    const plugins = chrome('plugins-overview');
    for (const part of ['**Reload**', '## Retired plugins', '## Plugins that add agent parts', 'API 0.7, 0.8 or 0.9']) expect(plugins, part).toContain(part);
    expect(plugins).not.toMatch(/\*\*Registered\*\*|\*\*Activated\*\*/);
    expect(chrome('plugins-permissions')).not.toContain("a plugin's agents start at your Default access");
  });

  it('names Settings pages the way the sidebar does', () => {
    for (const t of all()) expect(t.content, t.id).not.toMatch(/\*\*Settings > (Keyboard Shortcuts|Notifications & Alerts|What's New)\*\*/);
  });

  it('has no em dashes in the pages it rewrote', () => {
    for (const id of ['updates', 'troubleshooting-common', 'settings-themes', 'plugins-overview']) expect(chrome(id), id).not.toContain('—');
  });
});
