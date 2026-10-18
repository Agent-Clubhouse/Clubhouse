import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { DurableAgentConfig } from '../../../shared/types';
import { useProjectStore } from '../../stores/projectStore';
import { HelpersSettingsView } from './HelpersSettingsView';

const ALPHA = path.join('/work', 'alpha');
const BETA = path.join('/work', 'beta');

let cap: number;
let byProject: Record<string, DurableAgentConfig[]>;

const row = (id: string, name: string, extra: Partial<DurableAgentConfig> = {}): DurableAgentConfig => ({
  id, name, color: 'teal', createdAt: '2026-10-18T09:00:00Z', ...extra,
});

beforeEach(() => {
  cap = 20;
  byProject = {
    [ALPHA]: [
      row('lead', 'epic-lead'),
      // Disposed, orchestrator still here: reachable from its Helpers card.
      row('d1', 'merge-1', { parentAgentId: 'lead', disposedAt: '2026-10-18T10:00:00Z' }),
      // Disposed, orchestrator deleted.
      row('d2', 'impl-old', { parentAgentId: 'gone', disposedAt: '2026-10-17T10:00:00Z' }),
    ],
    [BETA]: [row('d3', 'qa-old', { disposedAt: '2026-10-16T10:00:00Z' })],
  };
  useProjectStore.setState({ projects: [{ id: 'pa', name: 'alpha', path: ALPHA }, { id: 'pb', name: 'beta', path: BETA }] } as never);
  window.clubhouse.app.getOrchestrationSettings = vi.fn(async () => ({ globalHelperCap: cap }));
  window.clubhouse.app.saveOrchestrationSettings = vi.fn(async (s: { globalHelperCap: number }) => { cap = s.globalHelperCap; });
  window.clubhouse.agent.listDurable = vi.fn(async (p: string) => byProject[p] ?? []) as never;
  window.clubhouse.agent.removeDisposed = vi.fn(async (p: string, id: string) => {
    byProject[p] = byProject[p].filter((c) => c.id !== id);
    return { ok: true, message: 'Removed' };
  });
});

afterEach(() => {
  useProjectStore.setState({ projects: [] });
});

describe('Helpers settings page (#2232)', () => {
  it('saves the app-wide cap within 1 to 100', async () => {
    render(<HelpersSettingsView />);
    const input = await screen.findByTestId('helpers-global-cap') as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('20'));

    fireEvent.change(input, { target: { value: '0' } });
    fireEvent.blur(input);
    expect(screen.getByTestId('helpers-global-cap-error')).toHaveTextContent('Enter a whole number from 1 to 100.');
    fireEvent.change(input, { target: { value: '101' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(window.clubhouse.app.saveOrchestrationSettings).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: '12' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(window.clubhouse.app.saveOrchestrationSettings).toHaveBeenCalledWith({ globalHelperCap: 12 }));
    expect(screen.queryByTestId('helpers-global-cap-error')).not.toBeInTheDocument();
  });

  it('puts the saved value back when saving fails', async () => {
    window.clubhouse.app.saveOrchestrationSettings = vi.fn(async () => { throw new Error('disk full'); });
    render(<HelpersSettingsView />);
    const input = await screen.findByTestId('helpers-global-cap') as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('20'));
    fireEvent.change(input, { target: { value: '30' } });
    fireEvent.blur(input);
    expect(await screen.findByTestId('helpers-global-cap-error')).toHaveTextContent('Couldn’t save. disk full');
    expect(input.value).toBe('20');
  });

  it('lists disposed helpers whose orchestrator is gone, and removes one after a confirm', async () => {
    render(<HelpersSettingsView />);
    const list = await screen.findByTestId('helpers-orphans');
    const rows = within(list).getAllByTestId('helpers-orphan-row');
    expect(rows.map((r) => r.textContent)).toEqual([expect.stringContaining('impl-old'), expect.stringContaining('qa-old')]);
    expect(rows[0]).toHaveTextContent('alpha');
    expect(list).not.toHaveTextContent('merge-1');

    fireEvent.click(within(rows[1]).getByTestId('helpers-orphan-remove'));
    expect(screen.getByText('Remove qa-old for good?')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('confirm-destructive-confirm'));
    await waitFor(() => expect(window.clubhouse.agent.removeDisposed).toHaveBeenCalledWith(BETA, 'd3'));
    await waitFor(() => expect(screen.getAllByTestId('helpers-orphan-row')).toHaveLength(1));
  });

  it('says there are none', async () => {
    byProject[ALPHA] = byProject[ALPHA].filter((c) => c.id !== 'd2');
    byProject[BETA] = [];
    render(<HelpersSettingsView />);
    expect(await screen.findByTestId('helpers-orphans-empty')).toBeInTheDocument();
  });
});
