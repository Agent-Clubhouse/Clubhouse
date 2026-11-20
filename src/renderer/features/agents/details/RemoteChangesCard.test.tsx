import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../../../../shared/types';
import type { RemoteAgentDetails } from '../../../../shared/remote-agent-details';
import type { RemoteAgentChanges } from '../../../../shared/remote-agent-changes';
import { useAnnexClientStore } from '../../../stores/annexClientStore';
import { RemoteChangesCard } from './RemoteChangesCard';
const agent = { id: 'remote||sat||a1', projectId: 'remote||sat||p1', name: 'Remote', kind: 'durable', status: 'running' } as Agent;
const details = { agentId: 'a1', readAt: 1, cards: [] } as unknown as RemoteAgentDetails;
const request = vi.fn();
const key = 'a'.repeat(64);
const fixture = (extra: Partial<RemoteAgentChanges> = {}): RemoteAgentChanges => ({ version: 1, readOnly: true, agentId: 'a1', observedAt: 1, scope: 'branch', state: 'ok', branch: 'feature', base: 'main', sessionId: null, turnId: null, live: true, shared: false,
  files: [{ path: 'src/file.ts', status: 'modified', fileKey: key, additions: 1, deletions: 1, countsKnown: true, binary: false, evidence: 'text' }], totalFiles: 1, offset: 0, nextOffset: null, uncompared: 0, skippedLarge: [], skippedRepos: [], skippedOmitted: 0, ...extra });
beforeEach(() => {
  useAnnexClientStore.setState({ satellites: [{ id: 'sat', state: 'connected', snapshot: {} }] as never });
  request.mockImplementation(async (_host, _id, query) => ({ status: 'ok', value: fixture({ scope: query.scope, offset: query.offset ?? 0, ...(query.fileKey && { files: [], patch: { fileKey: query.fileKey, state: 'text', text: '--- a/src/file.ts\n+++ b/src/file.ts\n@@ -1 +1 @@\n-before\n+after\n' } }) }) }));
  Object.assign(window.clubhouse.annexClient, { agentChanges: request });
  window.clubhouse.git.branchChanges = vi.fn();
  window.clubhouse.git.branchFilePatch = vi.fn();
});
const show = (extra = {}) => render(<RemoteChangesCard agent={agent} details={details} status="ok" freshnessKey="current" open onToggle={() => {}} {...extra} />);
describe('remote Changes read-only shared file view', () => {
  it.each([false, true])('keeps whole-comparison diffstat stable across pages with unknown counts=%s', async (unknown) => {
    const first = Array.from({ length: 50 }, (_, i) => ({ ...fixture().files[0], path: `file-${i}`, fileKey: i.toString(16).padStart(64, '0'), additions: 1, deletions: 2 }));
    const last = { ...fixture().files[0], path: 'last', fileKey: 'b'.repeat(64), status: unknown ? 'unknown' as const : 'modified' as const, additions: unknown ? 0 : 3, deletions: unknown ? 0 : 4, countsKnown: !unknown, evidence: unknown ? 'filtered' as const : 'text' as const };
    request.mockImplementation(async (_host, _id, query) => ({ status: 'ok', value: fixture({ files: query.offset ? [last] : first, totalFiles: 51, offset: query.offset ?? 0, nextOffset: query.offset ? null : 50, diffstat: { additions: unknown ? 50 : 53, deletions: unknown ? 100 : 104, knownFiles: unknown ? 50 : 51 } }) }));
    show();
    const summary = await screen.findByTestId('details-card-changes-summary');
    await waitFor(() => expect(summary).toHaveTextContent(unknown ? '51 paths · +50 −100 known · partial' : '51 paths · +53 −104'));
    fireEvent.click(screen.getByText('Next'));
    await screen.findByText('last');
    expect(summary).toHaveTextContent(unknown ? '51 paths · +50 −100 known · partial' : '51 paths · +53 −104');
    if (unknown) expect(screen.getByText(/Line totals are known for 50 of 51/)).toBeInTheDocument();
    else expect(summary).not.toHaveTextContent('partial');
    fireEvent.click(screen.getByText('Previous'));
    await screen.findByText('file-0');
    expect(summary).toHaveTextContent(unknown ? '+50 −100 known · partial' : '+53 −104');
  });
  it('labels old-host page counts and never accumulates independently observed pages into a total', async () => {
    request.mockImplementation(async (_host, _id, query) => ({ status: 'ok', value: fixture({ files: [{ ...fixture().files[0], additions: query.offset ? 8 : 2 }], totalFiles: 51, offset: query.offset ?? 0, nextOffset: query.offset ? null : 50 }) }));
    show();
    await waitFor(() => expect(screen.getByTestId('details-card-changes-summary')).toHaveTextContent('51 paths · +2 −1 on this page · partial'));
    expect(screen.getByText(/does not share aggregate line totals/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Next'));
    await waitFor(() => expect(screen.getByTestId('details-card-changes-summary')).toHaveTextContent('51 paths · +8 −1 on this page · partial'));
  });
  it.each([
    { files: [], totalFiles: 0, uncompared: 0, diffstat: { additions: 0, deletions: 0, knownFiles: 0 }, expected: '0 paths · +0 −0' },
    { files: [], totalFiles: 0, uncompared: 2, diffstat: { additions: 0, deletions: 0, knownFiles: 0 }, expected: '0 paths · line counts unavailable · partial' },
    { files: [{ ...fixture().files[0], countsKnown: false, evidence: 'binary' as const }], totalFiles: 1, uncompared: 0, diffstat: { additions: 0, deletions: 0, knownFiles: 0 }, expected: '1 paths · line counts unavailable · partial' },
    { files: fixture().files, totalFiles: 1, uncompared: 1, diffstat: { additions: 1, deletions: 1, knownFiles: 1 }, expected: '1 paths · +1 −1 known · partial' },
  ])('distinguishes empty, unavailable and incomplete line totals: $expected', async ({ expected, ...value }) => {
    request.mockResolvedValue({ status: 'ok', value: fixture(value) });
    show();
    await waitFor(() => expect(screen.getByTestId('details-card-changes-summary')).toHaveTextContent(expected));
  });
  it.each(['a1', 'remote||sat||'])('keeps malformed remote identity %s unavailable with no host request or local fallback', async (id) => {
    show({ agent: { ...agent, id } });
    expect(screen.getByTestId('details-card-changes')).toHaveTextContent('remote agent identity is unavailable');
    fireEvent.click(screen.getByText('Refresh changes'));
    await act(async () => { await Promise.resolve(); });
    expect(request).not.toHaveBeenCalled();
    expect(window.clubhouse.git.branchChanges).not.toHaveBeenCalled();
    expect(window.clubhouse.git.branchFilePatch).not.toHaveBeenCalled();
  });
  it('loads host branch files and their exact opaque-key diff without local git or revert controls', async () => {
    show();
    await screen.findByText('file.ts');
    expect(request).toHaveBeenCalledWith('sat', 'a1', { scope: 'branch', offset: 0 });
    fireEvent.click(screen.getByTestId('changes-file-row'));
    await waitFor(() => expect(request).toHaveBeenCalledWith('sat', 'a1', { scope: 'branch', fileKey: key }));
    await waitFor(() => expect(screen.getByTestId('changes-file-diff')).toHaveTextContent('after'));
    expect(window.clubhouse.git.branchChanges).not.toHaveBeenCalled();
    expect(window.clubhouse.git.branchFilePatch).not.toHaveBeenCalled();
    expect(screen.queryByText(/Revert|Undo/)).not.toBeInTheDocument();
  });
  it('reads paged session/turn evidence, shared work and every omission without claiming zero', async () => {
    request.mockImplementation(async (_host, _id, query) => ({ status: 'ok', value: fixture({ scope: query.scope, sessionId: 'host-session', turnId: query.scope === 'turn' ? 'last-turn' : null, shared: true, uncompared: 9, skippedLarge: ['large'], skippedRepos: ['nested'], skippedOmitted: 4, totalFiles: 60, offset: query.offset ?? 0, nextOffset: query.offset ? null : 50 }) }));
    show();
    await screen.findByText('file.ts');
    fireEvent.click(screen.getByRole('button', { name: 'Session', exact: true }));
    await waitFor(() => expect(request).toHaveBeenCalledWith('sat', 'a1', { scope: 'session', offset: 0 }));
    await screen.findByText('host-session');
    expect(screen.getByText(/9 paths were not compared/)).toBeInTheDocument();
    expect(screen.getByText(/Another agent worked/)).toBeInTheDocument();
    expect(screen.getByText(/Too large to checkpoint: large/)).toBeInTheDocument();
    expect(screen.getByText(/Repositories with no commits: nested/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Next'));
    await waitFor(() => expect(request).toHaveBeenCalledWith('sat', 'a1', { scope: 'session', offset: 50 }));
    fireEvent.click(screen.getByText('Last turn'));
    await waitFor(() => expect(request).toHaveBeenCalledWith('sat', 'a1', { scope: 'turn', offset: 0 }));
  });
  it('discards delayed previous-scope/agent reads and withholds cached files offline or after denied Details', async () => {
    let finish!: (value: unknown) => void;
    request.mockImplementation(async (_host, _id, query) => ({ status: 'ok', value: fixture({ scope: query.scope, diffstat: { additions: 1, deletions: 1, knownFiles: 1 } }) }));
    request.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const view = show();
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByText('Last turn'));
    await screen.findByText('file.ts');
    await act(async () => finish({ status: 'ok', value: fixture({ files: [{ ...fixture().files[0], path: 'STALE_PATH', additions: 999 }], diffstat: { additions: 999, deletions: 1, knownFiles: 1 } }) }));
    expect(screen.queryByText('STALE_PATH')).not.toBeInTheDocument();
    expect(screen.getByTestId('details-card-changes-summary')).not.toHaveTextContent('+999');
    view.rerender(<RemoteChangesCard agent={agent} details={null} status="forbidden" freshnessKey="current" open onToggle={() => {}} />);
    expect(screen.queryByText('file.ts')).not.toBeInTheDocument();
    expect(screen.getByTestId('details-card-changes')).toHaveTextContent('does not allow');
    expect(screen.getByTestId('details-card-changes-summary')).not.toHaveTextContent('+1');
    act(() => useAnnexClientStore.setState({ satellites: [{ id: 'sat', state: 'disconnected' }] as never }));
    expect(screen.getByTestId('details-card-changes')).toHaveTextContent('Host offline');
    expect(screen.getByTestId('details-card-changes-summary')).not.toHaveTextContent('+1');
  });
  it.each(['not-git', 'no-base', 'no-checkpoint', 'unsupported'] as const)('does not infer line totals for %s', async (state) => {
    request.mockResolvedValue({ status: 'ok', value: fixture({ state, files: [], totalFiles: 0 }) });
    show();
    await screen.findByText(/Changes need the agent|No main or master|No checkpoints recorded|scope is not supported/);
    expect(screen.getByTestId('details-card-changes-summary')).not.toHaveTextContent(/\+0|−0/);
    expect(screen.queryByText('No changes in this comparison.')).not.toBeInTheDocument();
  });
  it.each(['unavailable', 'error', 'forbidden', 'rate_limited'] as const)('keeps a %s host read separate from an empty comparison', async (status) => {
    request.mockResolvedValue({ status });
    show();
    await waitFor(() => expect(request).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText(/Loading changes/)).not.toBeInTheDocument());
    expect(screen.queryByText('No changes in this comparison.')).not.toBeInTheDocument();
  });
  it('preserves an older host’s available Details branch fields while marking scoped diffs/checkpoints unavailable', async () => {
    request.mockResolvedValue({ status: 'unavailable' });
    show({ details: { ...details, cards: [{ id: 'changes', title: 'Changes', summary: '2 files', rows: [{ label: 'old-host-file', value: '+2 −1' }], state: 'ok', notes: [], omitted: 3, observedAt: 1 }] } });
    await screen.findByText('old-host-file');
    expect(screen.getByTestId('details-card-changes')).toHaveTextContent('Scoped file diffs and checkpoints are not available');
    expect(screen.getByTestId('details-card-changes')).toHaveTextContent('3 more rows omitted');
    expect(window.clubhouse.git.branchChanges).not.toHaveBeenCalled();
  });
});
