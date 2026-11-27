import { describe, it, expect } from 'vitest';
import { HELP_SECTIONS } from './help-content';

describe('Actions help since 2026-11-08 (#3893)', () => {
  const content = HELP_SECTIONS.flatMap((s) => s.topics).find((t) => t.id === 'agents-actions')!.content;

  it('covers group projects, remote messages, owners and step limits', () => {
    for (const part of [
      '**Actions on other computers**', 'a message is posted, a member joins or leaves, or the board is idle', 'Copilot reports completed turns only',
      '**Post to the group board**', '**Tap a group member**', 'at most three steps', 'durable agent on another computer', '**Owner**',
      'up to 20 actions, a helper 5 and the Dispatcher 50', '### Group project actions', '**Run group project Actions**',
    ]) expect(content, part).toContain(part);
    expect(content).not.toContain('Copilot has no per-turn completion hook');
    expect(content).not.toContain('They run on this machine only.');
  });

  it('keeps to the words the app uses', () => {
    expect(content).not.toMatch(/\bautomations?\b|cron job/i);
    expect(content).not.toContain('—');
  });
});
