import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { BranchChanges } from '../../../../shared/git-branch';
import { ChangesReview, startsCollapsed } from './ChangesReview';

const PATCH = 'diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1,2 @@\n-export const a = 1;\n+export const a = 2;\n+export const b = 3;\n';

const branch: BranchChanges = {
  available: true, branch: 'agent/work', base: 'main', ahead: 2, uncommitted: 2,
  files: [
    { path: 'src/app.ts', status: 'modified', additions: 2, deletions: 1, binary: false },
    { path: 'package-lock.json', status: 'modified', additions: 900, deletions: 300, binary: false },
  ],
};

let git: typeof window.clubhouse.git;

beforeEach(() => {
  git = window.clubhouse.git;
  git.info = vi.fn(async () => ({
    branch: 'agent/work', branches: [], log: [], hasGit: true, ahead: 0, behind: 0, remote: 'origin', stashCount: 0, hasConflicts: false,
    status: [
      { path: 'src/app.ts', status: 'M', staged: true },
      { path: 'notes.md', status: '??', staged: false },
    ],
  }));
  git.branchLog = vi.fn(async () => [{ hash: 'abc123', shortHash: 'abc123', subject: 'feat: rows', author: 'A', date: '2 hours ago' }]);
  git.pullRequestInfo = vi.fn(async () => ({ available: true, branch: 'agent/work', base: 'main', remote: 'origin', hasRemote: true, github: true, pushed: false, compareUrl: 'https://github.com/o/r/compare/main...agent%2Fwork?expand=1' }));
  git.openPullRequest = vi.fn(async () => ({ ok: true, message: '' }));
  git.branchFilePatch = vi.fn(async () => ({ patch: PATCH }));
  git.stage = vi.fn(async () => ({ ok: true, message: '' }));
  git.unstage = vi.fn(async () => ({ ok: true, message: '' }));
  git.commit = vi.fn(async () => ({ ok: true, message: '' }));
  git.pushBranch = vi.fn(async () => ({ ok: true, message: '' }));
  git.showCommit = vi.fn(async () => ({ hash: 'abc123', files: [{ path: 'src/app.ts', status: 'M' }] }));
  git.commitDiff = vi.fn(async () => ({ original: 'a\n', modified: 'b\n' }));
  git.discard = vi.fn(async () => ({ ok: true, message: '' }));
  window.clubhouse.app.openExternalUrl = vi.fn(async () => {});
});

function renderReview(over: Partial<Parameters<typeof ChangesReview>[0]> = {}) {
  return render(<ChangesReview agentName="gallant-swift" cwd="/w" branch={branch} onChanged={vi.fn()} {...over} />);
}

describe('ChangesReview', () => {
  it('shows the branch against main with every file in one scroll, long and generated files collapsed', async () => {
    renderReview();
    expect(screen.getByTestId('review-branch')).toHaveTextContent('agent/work');
    expect(screen.getByTestId('review-ahead')).toHaveTextContent('2 commits ahead of main');
    const files = screen.getAllByTestId('review-file');
    expect(files.map((f) => f.getAttribute('data-path'))).toEqual(['src/app.ts', 'package-lock.json']);
    expect(files[0]).toHaveAttribute('data-open', 'true');
    expect(files[1]).not.toHaveAttribute('data-open');
    await waitFor(() => expect(within(files[0]).getByTestId('chat-diff-card')).toBeInTheDocument());
    expect(git.branchFilePatch).toHaveBeenCalledWith('/w', 'src/app.ts', undefined);
    expect(git.branchFilePatch).not.toHaveBeenCalledWith('/w', 'package-lock.json', undefined);
  });

  it('stages files and commits the staged ones', async () => {
    renderReview();
    const boxes = await screen.findAllByTestId('review-stage');
    expect(boxes[0]).toBeChecked();
    fireEvent.click(boxes[1]);
    await waitFor(() => expect(git.stage).toHaveBeenCalledWith('/w', 'notes.md'));
    fireEvent.change(screen.getByTestId('review-commit-message'), { target: { value: 'feat: rows' } });
    fireEvent.click(screen.getByTestId('review-commit'));
    await waitFor(() => expect(git.commit).toHaveBeenCalledWith('/w', 'feat: rows'));
  });

  it('shows a failed commit under the button', async () => {
    git.commit = vi.fn(async () => ({ ok: false, message: 'nothing to commit' }));
    renderReview();
    fireEvent.change(await screen.findByTestId('review-commit-message'), { target: { value: 'x' } });
    fireEvent.click(screen.getByTestId('review-commit'));
    expect(await screen.findByTestId('review-error')).toHaveTextContent('nothing to commit');
  });

  it('can hand the commit to the agent', async () => {
    const ask = vi.fn();
    renderReview({ onAskAgent: ask });
    fireEvent.change(await screen.findByTestId('review-commit-message'), { target: { value: 'feat: rows' } });
    fireEvent.click(screen.getByTestId('review-ask-agent'));
    expect(ask).toHaveBeenCalledWith('Commit the staged changes with this message: feat: rows');
  });

  it('pushes and opens the pull request page', async () => {
    renderReview();
    const button = await screen.findByTestId('review-open-pr');
    await waitFor(() => expect(button).toHaveTextContent('Push and open PR…'));
    expect(screen.getByTestId('review-pr-status')).toHaveTextContent('not pushed');
    fireEvent.click(button);
    // Opened through main, which checks the page is this repo's on GitHub.
    await waitFor(() => expect(git.openPullRequest).toHaveBeenCalledWith('/w', 'https://github.com/o/r/compare/main...agent%2Fwork?expand=1'));
    expect(git.pushBranch).toHaveBeenCalledWith('/w');
    expect(window.clubhouse.app.openExternalUrl).not.toHaveBeenCalled();
  });

  it('shows a refused page instead of opening it', async () => {
    git.pullRequestInfo = vi.fn(async () => ({ available: true, branch: 'agent/work', hasRemote: true, github: true, pushed: true, unpushed: 0, pr: { url: 'https://github.com/o/r/pull/9', number: 9, state: 'open' } }));
    git.openPullRequest = vi.fn(async () => ({ ok: false, message: 'That page isn\u2019t this repository\u2019s pull request on GitHub.' }));
    renderReview();
    const button = await screen.findByTestId('review-open-pr');
    await waitFor(() => expect(button).toHaveTextContent('Open pull request'));
    fireEvent.click(button);
    expect(await screen.findByTestId('review-error')).toHaveTextContent('isn\u2019t this repository');
  });

  it('says why it can\'t push a detached HEAD', async () => {
    git.pullRequestInfo = vi.fn(async () => ({ available: true }));
    renderReview();
    expect(await screen.findByTestId('review-pr-blocker')).toHaveTextContent('HEAD is detached');
    expect(screen.queryByTestId('review-open-pr')).not.toBeInTheDocument();
    expect(screen.getByTestId('review-push')).toBeDisabled();
  });

  it('says why there is nothing to push to', async () => {
    git.pullRequestInfo = vi.fn(async () => ({ available: true, branch: 'agent/work', hasRemote: false }));
    renderReview();
    expect(await screen.findByTestId('review-pr-blocker')).toHaveTextContent('no remote');
  });

  it('offers only Push for a remote that isn\'t on GitHub', async () => {
    git.pullRequestInfo = vi.fn(async () => ({ available: true, branch: 'agent/work', remote: 'gitlab', hasRemote: true, github: false, pushed: false }));
    renderReview();
    expect(await screen.findByTestId('review-pr-not-github')).toHaveTextContent('gitlab isn\'t on GitHub');
    expect(screen.queryByTestId('review-open-pr')).not.toBeInTheDocument();
    expect(screen.getByTestId('review-push')).not.toBeDisabled();
  });

  it('reloads an open diff when the file changes again', async () => {
    const { rerender } = renderReview();
    await waitFor(() => expect(git.branchFilePatch).toHaveBeenCalledTimes(1));
    const changed = { ...branch, files: [{ ...branch.files[0], additions: 5 }, branch.files[1]] };
    rerender(<ChangesReview agentName="gallant-swift" cwd="/w" branch={changed} onChanged={vi.fn()} />);
    await waitFor(() => expect(git.branchFilePatch).toHaveBeenCalledTimes(2));
  });

  it('reports a failed push instead of opening anything', async () => {
    git.pushBranch = vi.fn(async () => ({ ok: false, message: 'rejected: non-fast-forward' }));
    renderReview();
    const button = await screen.findByTestId('review-open-pr');
    await waitFor(() => expect(button).not.toBeDisabled());
    fireEvent.click(button);
    expect(await screen.findByTestId('review-error')).toHaveTextContent('rejected: non-fast-forward');
    expect(git.openPullRequest).not.toHaveBeenCalled();
  });

  it('narrows to one commit', async () => {
    renderReview();
    fireEvent.click(await screen.findByTestId('review-commit-row'));
    await waitFor(() => expect(git.showCommit).toHaveBeenCalledWith('/w', 'abc123'));
    expect(await screen.findByText('Everything on this branch')).toBeInTheDocument();
    await waitFor(() => expect(git.commitDiff).toHaveBeenCalledWith('/w', 'abc123', 'src/app.ts'));
  });

  it('confirms before discarding an uncommitted file', async () => {
    renderReview();
    fireEvent.click(await screen.findByRole('button', { name: 'Uncommitted' }));
    const file = (await screen.findAllByTestId('review-file')).find((f) => f.getAttribute('data-path') === 'notes.md')!;
    fireEvent.click(within(file).getByTestId('review-discard'));
    fireEvent.click(within(file).getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(git.discard).toHaveBeenCalledWith('/w', 'notes.md', true));
  });

  it('shows the project root without a branch, commits or pull request', async () => {
    renderReview({ root: { aside: <div data-testid="aside">branches</div> } });
    expect(screen.getByTestId('aside')).toBeInTheDocument();
    expect(screen.getByTestId('review-ahead')).toHaveTextContent('Project root');
    expect(screen.queryByTestId('review-open-pr')).not.toBeInTheDocument();
    expect(git.pullRequestInfo).not.toHaveBeenCalled();
  });
});

describe('startsCollapsed', () => {
  it('collapses long, binary and generated files', () => {
    expect(startsCollapsed({ path: 'a.ts', additions: 10, deletions: 2, binary: false })).toBe(false);
    expect(startsCollapsed({ path: 'a.ts', additions: 300, deletions: 200, binary: false })).toBe(true);
    expect(startsCollapsed({ path: 'img.png', additions: 0, deletions: 0, binary: true })).toBe(true);
    expect(startsCollapsed({ path: 'dist/app.js', additions: 1, deletions: 0, binary: false })).toBe(true);
    expect(startsCollapsed({ path: 'yarn.lock', additions: 1, deletions: 0, binary: false })).toBe(true);
  });
});
