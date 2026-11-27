import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HelperRoutingSettings, ProviderRoutingView } from '../../../shared/helper-routing';
import { autoPick, autoPickSentence } from './helper-auto-pick';
import { AutoHelpersHelp } from '../agents/helpers/OrchestrationFields';
import { HelperSelectionHelp } from '../managed/settings-fields';

const view = (fields: Record<string, unknown> = {}): ProviderRoutingView =>
  ({ autoEligible: true, autoCandidate: true, quota: { state: 'unknown', source: 'none', asOf: null }, choices: { source: 'live', asOf: null, models: [] }, cells: {}, ...fields }) as unknown as ProviderRoutingView;

const all = (copilot: Record<string, unknown> = {}): [string, ProviderRoutingView][] => [
  ['claude-code', view()],
  ['codex-cli', view()],
  ['copilot-cli', view(copilot)],
];

describe('autoPick (#3896)', () => {
  it('names Copilot as a last resort while it is allowed', () => {
    expect(autoPick(all(), true)).toBe('pick between Claude Code and Codex for a helper, favoring the CLI that has used less of its plan limit, with Copilot as a last resort');
  });

  it('leaves Copilot out when the last-resort switch is off', () => {
    expect(autoPick(all(), false)).toBe('pick between Claude Code and Codex for a helper, favoring the CLI that has used less of its plan limit');
  });

  it('leaves Copilot out when it is turned off in Agents & CLIs', () => {
    expect(autoPick(all({ enabled: false }), true)).not.toContain('Copilot');
  });

  it('says when Copilot is the only one left', () => {
    expect(autoPick([['claude-code', view({ available: false })], ['copilot-cli', view()]], true))
      .toBe('start a helper on Copilot, the only CLI turned on and available right now');
  });

  it('is null when nothing can be picked', () => {
    expect(autoPick([['claude-code', view({ enabled: false })], ['copilot-cli', view()]], false)).toBeNull();
  });
});

describe('autoPickSentence', () => {
  it('falls back to wording that holds for any setup until it is read', () => {
    const line = autoPickSentence(undefined, 'Let Clubhouse');
    expect(line).not.toMatch(/Claude Code|Codex|Copilot/);
    expect(line).toContain('Settings › Smart routing');
  });

  it('says when there is nothing to pick', () => {
    expect(autoPickSentence(null, 'Let Clubhouse')).toContain('nothing to pick');
  });
});

describe('help lines beside the Auto switches', () => {
  const original = window.clubhouse;
  afterEach(() => { (window as unknown as { clubhouse: unknown }).clubhouse = original; });

  function withRouting(settings: Partial<HelperRoutingSettings> | Error): void {
    const getHelperRouting = vi.fn(() => (settings instanceof Error ? Promise.reject(settings) : Promise.resolve(settings)));
    (window as unknown as { clubhouse: unknown }).clubhouse = { ...original, app: { ...original?.app, getHelperRouting } };
  }

  it('the Smart routing help reads what it can pick now, Copilot included', async () => {
    withRouting({ providers: Object.fromEntries(all()), copilotAuto: true });
    render(<AutoHelpersHelp />);
    expect(await screen.findByText(/with Copilot as a last resort\. This balances plan use, not cost\./)).toBeTruthy();
    expect(screen.getByText(/^Let Clubhouse pick between Claude Code and Codex/)).toBeTruthy();
  });

  it('the Helper selection help does too, and keeps the Fixed line', async () => {
    withRouting({ providers: Object.fromEntries(all()), copilotAuto: false });
    render(<HelperSelectionHelp />);
    const line = await screen.findByText(/^Auto lets Smart routing pick between Claude Code and Codex/);
    expect(line.textContent).not.toContain('Copilot');
    expect(line.textContent).toContain('Fixed keeps the CLI the agent names.');
  });

  it('keeps the general wording when the read fails', async () => {
    withRouting(new Error('no'));
    render(<AutoHelpersHelp />);
    await Promise.resolve();
    expect(screen.getByText(/^Let Clubhouse pick the CLI for a helper, favoring/)).toBeTruthy();
  });
});
