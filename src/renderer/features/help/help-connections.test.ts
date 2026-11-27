import { describe, it, expect, afterEach } from 'vitest';
import { NEW_LAYOUT_TOPICS, getHelpSections } from './help-content';
import { useChromeFlagStore } from '../../chrome/chromeFlag';

describe('connections help in the new layout', () => {
  afterEach(() => useChromeFlagStore.setState({ enabled: false }));
  const topic = (id: string) => NEW_LAYOUT_TOPICS.find((n) => n.topic.id === id)!.topic;

  describe('Connections and Canvas (#3892)', () => {
    it('follow the Dispatcher in the agents section', () => {
      useChromeFlagStore.setState({ enabled: true });
      const agents = getHelpSections().find((s) => s.id === 'agents')!.topics.map((t) => t.id);
      expect(agents.indexOf('agents-connections')).toBe(agents.indexOf('agents-dispatcher') + 1);
      expect(agents.indexOf('canvas')).toBe(agents.indexOf('agents-connections') + 1);
      expect(topic('agents-connections').title).toBe('Connections');
      expect(topic('canvas').title).toBe('Canvas');
    });

    it('lists each direction switch and the defaults for a new connection', () => {
      const content = topic('agents-connections').content;
      for (const row of [
        '| **See status** |', '| **Read output** |', '| **Check it is reachable** |', '| **Send messages** |', '| **Send files** |',
        '| **Clear its context** | Clear its conversation | No |', '| **Compact its context** | Compact its conversation | No |', '| **Wake it** |',
      ]) expect(content, row).toContain(row);
      expect(content).toContain("A switch never gives more than the sender's own Clubhouse permissions allow");
    });

    it('covers adding, editing, guidance and other computers with the labels that ship', () => {
      const content = topic('agents-connections').content;
      for (const part of [
        '**Add connection**', '**This computer**', '**Other computers**', '**Dispatchers**', '**Group projects**', '**One way**', '**Two way**',
        '**Edit**', '**Open**', '**Make two-way**', '**Remove**', '**Guidance**', '**Save direction**', '**On other computers**', '**Drag to connect**',
      ]) expect(content, part).toContain(part);
    });

    it('covers adding to a canvas, connecting on it and group project boards', () => {
      const content = topic('canvas').content;
      for (const part of [
        '**Add to canvas**', '**Agent**', '**Browser**', '**Sticky note**', '**Group project**', '**Drag to connect**', '**Both directions**',
        '**Tool permissions**', '**Disconnect**', '**Open group project**', '**Back to Canvas**', '**Preview board (read-only)**',
      ]) expect(content, part).toContain(part);
    });
  });
});
