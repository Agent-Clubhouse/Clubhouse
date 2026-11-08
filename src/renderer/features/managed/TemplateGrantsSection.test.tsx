import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { TemplateGrantsSection, withTemplateRow } from './TemplateGrantsSection';
import { changeText } from './TemplatePushDialog';
import { builderSettings, copySeed, templateSeed } from '../../chrome/pages/NewManagedAgentSteps';

const msg = { action: 'agent.message' as const, target: { kind: 'connected' as const } };

describe('a template\'s Clubhouse permissions (#2971)', () => {
  it('a row set away from its default is kept; set back, it goes', () => {
    const row = { ...msg, mode: 'allow' as const, defaultMode: 'allow' as const, source: 'every_agent' as const, fixed: false };
    const off = withTemplateRow(undefined, row, 'off', 'allow');
    expect(off).toEqual([{ ...msg, mode: 'off' }]);
    expect(withTemplateRow(off, row, 'allow', 'allow')).toBeUndefined();
  });

  it('shows the defaults with the template\'s changes, and Helper control\'s rows can\'t be changed here', () => {
    const onChange = vi.fn();
    render(<TemplateGrantsSection settings={{ orchestration: { orchestrate: true }, grants: [{ ...msg, mode: 'off' }] }} onChange={onChange} />);
    const message = screen.getByRole('radiogroup', { name: 'Send messages and files (Connected agents)' });
    expect(within(message).getByRole('radio', { name: 'Off' })).toBeChecked();
    expect(screen.getAllByText('From its template').length).toBeGreaterThan(0);
    const create = screen.getByRole('radiogroup', { name: 'Create agents (Its project)' });
    expect(within(create).getByRole('radio', { name: 'Allow' })).toBeDisabled();
    expect(screen.getAllByText('Follows Helper control.').length).toBe(2);

    fireEvent.click(within(message).getByRole('radio', { name: 'Allow' }));
    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  it('the push dialog names the permission', () => {
    expect(changeText({ kind: 'setting', key: 'grants.agent.message@connected', from: 'Off', to: 'default', label: 'Clubhouse permission: Send messages and files (Connected agents)' }))
      .toBe('~ Clubhouse permission: Send messages and files (Connected agents) Off → default');
  });

  it('a template\'s and a copied agent\'s permissions go to the new agent', () => {
    const grants = [{ ...msg, mode: 'off' as const }];
    const seed = templateSeed({ id: 't', name: 'T', description: '', builtin: false, usedBy: 0, setup: { blocks: [], skills: [], mcps: [] }, settings: { grants } });
    const draft = { orchestrate: false, model: 'default', idleSleep: 'inherit' } as unknown as Parameters<typeof builderSettings>[0];
    expect(builderSettings(draft, seed, { orchestrator: 'claude-code', supportsPermissions: true, defaultAccess: 'ask', limit: 3 }).grants).toEqual(grants);
    const copied = copySeed({ agent: { id: 'a', name: 'A' } as never, setup: { blocks: [], skills: [], mcps: [] }, config: { grants } });
    expect(copied.settings.grants).toEqual(grants);
  });
});
