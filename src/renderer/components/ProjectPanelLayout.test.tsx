import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { useHelperDisposeRequestStore } from '../stores/helperDisposeRequestStore';
import { ProjectPanelLayout } from './ProjectPanelLayout';

vi.mock('../panels/ExplorerRail', () => ({ ExplorerRail: () => <div data-testid="explorer-rail" /> }));
vi.mock('../panels/AccessoryPanel', () => ({ AccessoryPanel: () => <div data-testid="accessory-panel" /> }));
vi.mock('../panels/MainContentView', () => ({ MainContentView: () => <div data-testid="main-content" /> }));
vi.mock('../features/agents/helpers/DisposeHelperDialog', () => ({
  DisposeHelperDialog: ({ helper, requestedBy }: { helper: { name: string }; requestedBy?: string }) => (
    <div data-testid="dispose-helper-dialog">{requestedBy} asked to dispose of {helper.name}</div>
  ),
}));

afterEach(() => {
  useHelperDisposeRequestStore.setState({ requests: {}, reviewing: null });
});

describe('ProjectPanelLayout (default layout)', () => {
  it('opens the dispose dialog for an orchestrator’s request under review', () => {
    render(<ProjectPanelLayout />);
    expect(screen.queryByTestId('dispose-helper-dialog')).toBeNull();
    act(() => {
      useHelperDisposeRequestStore.getState().add({
        helperId: 'h1', helperName: 'impl-ipc', orchestratorId: 'orch', projectPath: '/project',
        checks: { dirty: 0, unpushed: 0, unmerged: 0 }, forceRequested: false,
      } as never, 'orch');
      useHelperDisposeRequestStore.getState().review('h1');
    });
    expect(screen.getByTestId('dispose-helper-dialog')).toHaveTextContent('orch asked to dispose of impl-ipc');
  });
});
