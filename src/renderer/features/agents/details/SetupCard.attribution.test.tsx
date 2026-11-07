import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../../../../shared/types';
import type { ManagedAgentSetup, ManagedPartSummary } from '../../../../shared/managed-agents-types';
import { useProjectStore } from '../../../stores/projectStore';
import { SettingsCard } from './SettingsCard';
import { useAgentDetailsStore } from './detailsStore';

/** The Setup card says what a helper was built from (#2899) and who changed a setup or template over MCP (#2900). */

const agent: Agent = {
  id: 'h1', projectId: 'p1', name: 'scout', kind: 'durable', status: 'running', color: 'teal', orchestrator: 'claude-code',
};
const m = () => window.clubhouse.managed;
const twoMinutesAgo = () => new Date(Date.now() - 2 * 60_000).toISOString();

const part = (id: string, kind: ManagedPartSummary['kind'], name: string): ManagedPartSummary => ({
  id, kind, name, description: '', builtin: false, revision: 1, updatedAt: '', usedBy: [], templates: [], preview: '',
});

function mockSetup(setup: ManagedAgentSetup, template: { updatedBy?: string; updatedAt?: string } = {}) {
  vi.spyOn(m(), 'getSetup').mockResolvedValue({ ok: true, value: setup } as never);
  vi.spyOn(m(), 'listTemplates').mockResolvedValue({
    ok: true, value: [{ id: 't-helper', name: 'Helper', description: '', builtin: false, setup: { blocks: [], skills: [], mcps: [] }, settings: {}, usedBy: 1, ...template }],
  } as never);
  vi.spyOn(m(), 'listParts').mockImplementation(async (kind) => ({
    ok: true,
    value: kind === 'block' ? [part('b-cr', 'block', 'code-review')] : kind === 'mcp' ? [part('m-pw', 'mcp', 'Playwright')] : [],
  }) as never);
  vi.spyOn(m(), 'status').mockResolvedValue({ ok: true, value: { managed: true, running: true, waiting: false, changes: [], cliChanged: false } } as never);
}

beforeEach(() => {
  vi.restoreAllMocks();
  useProjectStore.setState({ projects: [{ id: 'p1', name: 'proj', path: '/work/proj' }] as never });
  useAgentDetailsStore.setState({ open: true, settingsOpen: true, focus: null });
});

afterEach(() => {
  useProjectStore.setState({ projects: [] });
});

describe('Setup card attribution and helper changes', () => {
  it('says what a helper was built from, with names from the library', async () => {
    mockSetup({ version: 1, blocks: [], skills: [], mcps: ['m-pw'], templateId: 't-helper', helperChanges: { added: ['m-pw'], removed: ['b-cr'] } });
    render(<SettingsCard agent={agent} projectPath="/work/proj" provider="Claude Code" />);
    await waitFor(() => expect(screen.getByTestId('details-setup-built-from')).toHaveTextContent('Helper template, plus Playwright, minus code-review'));
    expect(screen.queryByTestId('details-setup-template')).toBeNull();
  });

  it('says the Dispatcher changed the setup, and when', async () => {
    mockSetup({ version: 1, blocks: [], skills: [], mcps: [], templateId: 't-helper', updatedBy: 'Dispatcher', updatedAt: twoMinutesAgo() });
    render(<SettingsCard agent={agent} projectPath="/work/proj" provider="Claude Code" />);
    expect(await screen.findByTestId('details-setup-changed')).toHaveTextContent('Changed by Dispatcher, 2m ago.');
  });

  it('says the Dispatcher changed its template, and nothing for a person\'s change', async () => {
    mockSetup({ version: 1, blocks: [], skills: [], mcps: [], templateId: 't-helper', updatedAt: twoMinutesAgo() }, { updatedBy: 'Dispatcher', updatedAt: twoMinutesAgo() });
    render(<SettingsCard agent={agent} projectPath="/work/proj" provider="Claude Code" />);
    expect(await screen.findByTestId('details-setup-template-changed')).toHaveTextContent('Template changed by Dispatcher, 2m ago.');
    expect(screen.queryByTestId('details-setup-changed')).toBeNull();
  });
});
