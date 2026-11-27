import { describe, it, expect, afterEach } from 'vitest';
import { getHelpSections } from './help-content';
import { useChromeFlagStore } from '../../chrome/chromeFlag';

describe('Annex Network help (#3891)', () => {
  afterEach(() => useChromeFlagStore.setState({ enabled: false }));

  it('describes the one network page, pairing, devices and the sidebar as they ship', () => {
    useChromeFlagStore.setState({ enabled: true });
    const topic = getHelpSections().flatMap((s) => s.topics).find((t) => t.id === 'settings-annex')!;
    expect(topic.title).toBe('Annex Network');
    for (const part of [
      '**Annex Network on this computer**', '**Device name**', '**Only accept connections from this computer**', '**Add a device**',
      '**Discovered on this network**', '**Paste pairing link**', '**Pair without a link**', '**One-time code**', 'Clubhouse Go',
      '**Devices**', '**Pair again**', '**Show**', '**Link** or **Keep separate**', '**Accept handoffs from other computers** is on by default',
      '## Each direction, and forwards', '**Allow pairing again**', '**Reset Annex Network**',
    ]) expect(topic.content, part).toContain(part);
    expect(topic.content).not.toMatch(/satellite|\*\*Annex control\*\*|Allow remote control|Pairing PIN|CLI view|\*\*Alias\*\*/i);
    expect(topic.content).not.toContain('—');
  });
});
