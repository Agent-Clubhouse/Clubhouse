import { describe, it, expect } from 'vitest';
import { HELP_SECTIONS, CHROME_HELP_SECTIONS } from './help-content';

describe('Helpers and Smart routing in the new layout (#3896)', () => {
  const content = CHROME_HELP_SECTIONS.flatMap((s) => s.topics).find((t) => t.id === 'agents-orchestrated-helpers')!.content;

  it('names the settings, presets and Smart routing rules that ship', () => {
    for (const part of [
      '**Let this agent orchestrate**', '**Approvals**', '**Hands-off**', '**Ask before starting**', '**Ask for everything**', '**Helpers at once**',
      '**Cross-project helpers**', '**Helper selection**', '**App setting**', '**Fixed**', '**Default helper template**', '**Let orchestrators choose helper templates**',
      '**Minimum**', '**Maximum**', '**Same as Easy**', '**Check again**', '**Review Smart routing**',
      '**Let orchestrators use Smart routing for helpers**', "It's off by default", '80%', '95% or more', '**Allow Copilot as a last resort**',
      '**Prefer useful work before quota resets**', '**Keep for me (%)**', '**Helpers running at once**',
    ]) expect(content, part).toContain(part);
    for (const tool of ['start_helper', 'list_helpers', 'sleep_helper', 'wake_helper', 'list_models', 'message_parent']) expect(content, tool).toContain(`\`${tool}\``);
  });

  it('uses the 1.0 words', () => {
    expect(content).not.toMatch(/\b(dispose|disposing|disposed|wires?)\b/i);
    expect(content).not.toMatch(/Smart selection|Auto provider/);
    expect(content).not.toContain('\u2014');
    expect(content).not.toMatch(/[A-Z]{4,} [A-Z]{4,}/);
  });

  it('no longer says a CLI near its limit goes last', () => {
    for (const sections of [HELP_SECTIONS, CHROME_HELP_SECTIONS]) {
      const text = sections.flatMap((s) => s.topics).find((t) => t.id === 'agents-orchestrated-helpers')!.content;
      expect(text).not.toContain('close to any of its limits goes last');
    }
  });
});
