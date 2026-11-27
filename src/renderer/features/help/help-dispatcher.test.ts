import { describe, it, expect } from 'vitest';
import { DISPATCHER_TOPIC } from './help-content';

describe('Dispatcher help as it ships (#2584)', () => {
  it('uses the labels and defaults on main', () => {
    const content = DISPATCHER_TOPIC.content;
    for (const part of [
      '**Turned off**', '**Link tripped**', '**Link paused**', "**This computer's earlier chat**", '**Send later**',
      'default to Allow for the Dispatcher and the agents connected to it', 'rename and restart any agent', 'deletes an agent',
      '**What it\'s told**', '**Other computers**', '**Lead**',
    ]) expect(content, part).toContain(part);
    expect(content).not.toMatch(/non-disposed|This machine's earlier chat|Ask first for agents connected to it|under \*\*Manage\*\*/);
  });
});
