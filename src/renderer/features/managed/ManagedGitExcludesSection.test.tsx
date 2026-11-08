import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ManagedGitExcludesSection } from './ManagedGitExcludesSection';

const m = () => window.clubhouse.managed;

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('ManagedGitExcludesSection (D97)', () => {
  it('names the files git ignores for the whole repository, and says tracked files aren\'t affected', async () => {
    const spy = vi.spyOn(m(), 'projectGitExcludes').mockResolvedValue({ ok: true, value: ['/.claude/settings.local.json', '/.mcp.json', '/CLAUDE.md'] });
    render(<ManagedGitExcludesSection projectPath="/p" />);
    const section = await screen.findByTestId('managed-git-excludes');
    await waitFor(() => expect(section.textContent).toContain('/CLAUDE.md'));
    expect(spy).toHaveBeenCalledWith('/p');
    expect(section.textContent).toContain('for the whole repository, in the main checkout and every worktree');
    expect(section.textContent).toContain('/.mcp.json');
    expect(section.textContent).toContain('/.claude/settings.local.json');
    expect(section.textContent).toContain('Files git already tracks aren\'t affected');
    expect(section.textContent).not.toContain('—');
  });

  it('says what happens once a managed agent needs them when none do yet', async () => {
    render(<ManagedGitExcludesSection projectPath="/p" />);
    const section = await screen.findByTestId('managed-git-excludes');
    await waitFor(() => expect(section.textContent).toContain('Git ignores nothing for managed agents in this project right now.'));
    expect(section.textContent).toContain('Files git already tracks aren\'t affected');
  });
});
