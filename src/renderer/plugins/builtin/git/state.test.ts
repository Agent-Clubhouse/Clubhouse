import { describe, it, expect, afterEach } from 'vitest';
import { gitState } from './state';

afterEach(() => {
  // Restore a clean baseline without going through the public reset (which is
  // itself under test) so one test can't leak listeners into another.
  gitState.setSelectedFile(null);
  gitState.setSelectedCommit(null);
  gitState.listeners.clear();
});

describe('gitState.reset', () => {
  it('clears data and UI selection state', () => {
    gitState.setSelectedFile('src/a.ts');
    gitState.setSelectedCommit('abc123');
    gitState.setCommitMessage('wip');

    gitState.reset();

    expect(gitState.selectedFile).toBeNull();
    expect(gitState.selectedCommit).toBeNull();
    expect(gitState.commitMessage).toBe('');
  });

  it('keeps listeners subscribed so mounted panels keep updating', () => {
    let notifications = 0;
    gitState.subscribe(() => { notifications += 1; });

    gitState.reset();
    expect(notifications).toBeGreaterThan(0); // reset itself notifies

    const afterReset = notifications;
    gitState.setSelectedFile('src/b.ts');
    expect(notifications).toBe(afterReset + 1); // still receiving updates
  });
});
