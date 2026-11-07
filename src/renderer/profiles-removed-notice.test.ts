import { beforeEach, describe, expect, it, vi } from 'vitest';
import { removedProfilesMessage, showRemovedProfilesNotice } from './profiles-removed-notice';
import { useToastStore } from './stores/toastStore';

describe('removed provider profiles notice (#2749)', () => {
  beforeEach(() => {
    useToastStore.setState({ toasts: [] });
  });

  it('names each removed profile with the variable names it set', () => {
    expect(removedProfilesMessage({ profiles: [
      { name: 'Work', variables: { 'claude-code': ['CLAUDE_CONFIG_DIR'], 'codex-cli': ['CODEX_HOME', 'OPENAI_API_KEY'] } },
      { name: 'Personal', variables: { 'claude-code': ['CLAUDE_CONFIG_DIR'] } },
      { name: 'Empty', variables: {} },
    ] })).toBe(
      'Provider profiles were removed, so agents now use each CLI\'s normal signed-in environment. '
      + 'The removed profiles were Work (CLAUDE_CONFIG_DIR, CODEX_HOME, OPENAI_API_KEY), Personal (CLAUDE_CONFIG_DIR) and Empty.',
    );
    expect(removedProfilesMessage({ profiles: [{ name: 'Work', variables: { 'codex-cli': ['CODEX_HOME'] } }] }))
      .toContain('The removed profile was Work (CODEX_HOME).');
  });

  it('shows one info toast when main has a notice', async () => {
    vi.mocked(window.clubhouse.app.takeRemovedProfilesNotice).mockResolvedValueOnce({ profiles: [{ name: 'Work', variables: { 'codex-cli': ['CODEX_HOME'] } }] });
    await showRemovedProfilesNotice();
    expect(useToastStore.getState().toasts).toEqual([expect.objectContaining({ type: 'info', message: expect.stringContaining('Work (CODEX_HOME)') })]);
  });

  it('shows nothing without one, or when the read fails', async () => {
    vi.mocked(window.clubhouse.app.takeRemovedProfilesNotice).mockResolvedValueOnce(null);
    await showRemovedProfilesNotice();
    vi.mocked(window.clubhouse.app.takeRemovedProfilesNotice).mockRejectedValueOnce(new Error('gone'));
    await showRemovedProfilesNotice();
    expect(useToastStore.getState().toasts).toEqual([]);
  });
});
