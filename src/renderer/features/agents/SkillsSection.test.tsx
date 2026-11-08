import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SkillsSection } from './SkillsSection';
import type { SkillEntry } from '../../../shared/types';

// Mock SettingsMonacoEditor since it requires Monaco
vi.mock('../../components/SettingsMonacoEditor', () => ({
  SettingsMonacoEditor: ({ value, onChange, readOnly }: any) => (
    <textarea
      data-testid="monaco-editor"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      readOnly={readOnly}
    />
  ),
}));

const mockSkills: SkillEntry[] = [
  { name: 'mission', path: '/project/.claude/skills/mission' },
  { name: 'review', path: '/project/.claude/skills/review' },
];

function renderSkills(overrides: Partial<React.ComponentProps<typeof SkillsSection>> = {}) {
  return render(
    <SkillsSection
      worktreePath="/project"
      disabled={false}
      refreshKey={0}
      {...overrides}
    />,
  );
}

describe('SkillsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.clubhouse.agentSettings.listSkills = vi.fn().mockResolvedValue(mockSkills);
    window.clubhouse.agentSettings.readSkillContent = vi.fn().mockResolvedValue('# Mission\n\nDo things.');
    window.clubhouse.agentSettings.writeSkillContent = vi.fn().mockResolvedValue(undefined);
    window.clubhouse.agentSettings.deleteSkill = vi.fn().mockResolvedValue(undefined);
    window.clubhouse.file.showInFolder = vi.fn();
  });

  describe('found on disk vs reported loaded (#2929)', () => {
    const report = (names: string[] | null) => ({
      supported: true,
      report: { provider: 'claude-code' as const, driver: 'claude_agent_sdk' as const, source: 'system/init' as const, nativeSessionId: 'n', sessionId: 's', reportedAt: 0, names },
    });
    const disk: SkillEntry[] = [
      { name: 'build', path: '/wt/.claude/skills/build', hasReadme: false, skillName: 'build', managed: true },
      { name: 'notes', path: '/wt/.claude/skills/notes', hasReadme: false, skillName: 'note-taking' },
      { name: 'stray', path: '/wt/.claude/skills/stray', hasReadme: false },
    ];
    beforeEach(() => { window.clubhouse.agentSettings.listSkills = vi.fn().mockResolvedValue(disk); });

    it('never shows a skill as loaded from the files alone', async () => {
      renderSkills({ providerName: 'Claude Code', scope: 'agent' });
      expect(await screen.findByTestId('skill-evidence-build')).toHaveTextContent('Claude Code · Agent folder · Managed by Clubhouse · Loaded: not confirmed');
      expect(screen.getByTestId('skill-evidence-stray')).toHaveTextContent('Not managed by Clubhouse · Loaded: not confirmed');
      expect(screen.queryByText(/Reported loaded/)).toBeNull();
    });

    it('a report with no valid list confirms nothing', async () => {
      renderSkills({ providerName: 'Claude Code', reported: report(null) });
      expect(await screen.findByTestId('skill-evidence-build')).toHaveTextContent('Loaded: not confirmed');
    });

    it('shows a skill the provider reported, by folder or SKILL.md name, and only those', async () => {
      renderSkills({ providerName: 'Claude Code', reported: report(['build', 'note-taking', 'plugin:other']) });
      expect(await screen.findByTestId('skill-evidence-build')).toHaveTextContent('Reported loaded by Claude Code');
      expect(screen.getByTestId('skill-evidence-notes')).toHaveTextContent('Reported loaded by Claude Code');
      expect(screen.getByTestId('skill-evidence-stray')).toHaveTextContent('Loaded: not confirmed');
    });

    it('names the folder it read: the project folder for an agent without one', async () => {
      renderSkills({ providerName: 'Codex', scope: 'project' });
      expect(await screen.findByTestId('skill-evidence-build')).toHaveTextContent('Codex · Project folder');
      expect(screen.getByTestId('skills-evidence-note')).toHaveTextContent('Found on disk in the project folder. A skill shows as loaded only when Codex reports it for the running session.');
    });
  });

  it('passes selected identity and discards a late prior-target list', async () => {
    let finish!: (value: SkillEntry[]) => void;
    window.clubhouse.agentSettings.listSkills = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; })).mockResolvedValue([{ name: 'current', path: '/b/.github/skills/current' }]);
    const count = vi.fn();
    const view = renderSkills({ worktreePath: '/a', projectPath: '/p', agentId: 'a', onCountChange: count });
    view.rerender(<SkillsSection worktreePath="/b" projectPath="/p" agentId="b" disabled={false} refreshKey={0} onCountChange={count} />);
    expect(await screen.findByText('current')).toBeInTheDocument();
    await act(async () => finish([{ name: 'obsolete', path: '/a/.claude/skills/obsolete' }]));
    expect(screen.queryByText('obsolete')).not.toBeInTheDocument();
    expect(window.clubhouse.agentSettings.listSkills).toHaveBeenLastCalledWith('/b', '/p', 'b');
    expect(count).toHaveBeenCalledTimes(1);
    expect(screen.getByText('/b/.github/skills/current')).toBeInTheDocument();
  });

  describe('list view', () => {
    it('renders the Skills heading', async () => {
      renderSkills();
      expect(screen.getByText('Skills')).toBeInTheDocument();
    });

    it('renders skill entries after loading', async () => {
      renderSkills();
      expect(await screen.findByText('mission')).toBeInTheDocument();
      expect(screen.getByText('review')).toBeInTheDocument();
    });

    it('renders empty state when no skills exist', async () => {
      window.clubhouse.agentSettings.listSkills = vi.fn().mockResolvedValue([]);
      renderSkills();
      expect(await screen.findByText('No skills defined.')).toBeInTheDocument();
    });

    it('renders the New skill button', async () => {
      renderSkills();
      expect(await screen.findByText('New skill')).toBeInTheDocument();
    });

    it('shows custom path label when provided', () => {
      renderSkills({ pathLabel: '.codex/skills/' });
      expect(screen.getByText('.codex/skills/')).toBeInTheDocument();
    });

    it('shows default path label when not provided', () => {
      renderSkills();
      expect(screen.getByText('.claude/skills/')).toBeInTheDocument();
    });

    it('disables New skill button when disabled', async () => {
      renderSkills({ disabled: true });
      const btn = await screen.findByText('New skill');
      expect(btn).toBeDisabled();
    });
  });

  describe('create flow', () => {
    it('switches to create view on New skill click', async () => {
      renderSkills();
      await screen.findByText('mission');
      fireEvent.click(screen.getByText('New skill'));
      expect(screen.getByText('New skill')).toBeInTheDocument();
      expect(screen.getByPlaceholderText('skill-name (lowercase, hyphens)')).toBeInTheDocument();
    });

    it('Save button is disabled when skill name is empty', async () => {
      renderSkills();
      await screen.findByText('mission');
      fireEvent.click(screen.getByText('New skill'));
      expect(screen.getByText('Save')).toBeDisabled();
    });

    it('Save button enables when skill name is provided', async () => {
      renderSkills();
      await screen.findByText('mission');
      fireEvent.click(screen.getByText('New skill'));
      fireEvent.change(screen.getByPlaceholderText('skill-name (lowercase, hyphens)'), {
        target: { value: 'deploy' },
      });
      expect(screen.getByText('Save')).not.toBeDisabled();
    });

    it('saves new skill and returns to list', async () => {
      renderSkills();
      await screen.findByText('mission');
      fireEvent.click(screen.getByText('New skill'));
      fireEvent.change(screen.getByPlaceholderText('skill-name (lowercase, hyphens)'), {
        target: { value: 'deploy' },
      });
      fireEvent.click(screen.getByText('Save'));

      await waitFor(() => {
        expect(window.clubhouse.agentSettings.writeSkillContent).toHaveBeenCalledWith(
          '/project',
          'deploy',
          expect.any(String),
          undefined, undefined,
        );
      });
    });

    it('Cancel returns to list view', async () => {
      renderSkills();
      await screen.findByText('mission');
      fireEvent.click(screen.getByText('New skill'));
      expect(screen.getByText('New skill')).toBeInTheDocument();
      fireEvent.click(screen.getByText('Cancel'));
      expect(await screen.findByText('Skills')).toBeInTheDocument();
    });
  });

  describe('edit flow', () => {
    it('switches to edit view when skill name is clicked', async () => {
      renderSkills();
      const skillBtn = await screen.findByText('mission');
      fireEvent.click(skillBtn);

      await waitFor(() => {
        expect(window.clubhouse.agentSettings.readSkillContent).toHaveBeenCalledWith(
          '/project', 'mission', undefined, undefined,
        );
      });
      expect(await screen.findByText('Edit: mission')).toBeInTheDocument();
    });

    it('saves edited skill and returns to list', async () => {
      renderSkills();
      fireEvent.click(await screen.findByText('mission'));
      await screen.findByText('Edit: mission');

      fireEvent.click(screen.getByText('Save'));
      await waitFor(() => {
        expect(window.clubhouse.agentSettings.writeSkillContent).toHaveBeenCalledWith(
          '/project', 'mission', expect.any(String), undefined, undefined,
        );
      });
    });
  });

  describe('delete flow', () => {
    it('shows delete confirmation dialog', async () => {
      renderSkills();
      await screen.findByText('mission');
      // Find delete buttons by title
      const deleteButtons = screen.getAllByTitle('Delete skill');
      fireEvent.click(deleteButtons[0]);
      expect(screen.getByText('Delete skill')).toBeInTheDocument();
      expect(screen.getByText(/cannot be undone/)).toBeInTheDocument();
    });

    it('deletes skill when confirmed', async () => {
      renderSkills();
      await screen.findByText('mission');
      fireEvent.click(screen.getAllByTitle('Delete skill')[0]);
      fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

      await waitFor(() => {
        expect(window.clubhouse.agentSettings.deleteSkill).toHaveBeenCalledWith(
          '/project', 'mission', undefined, undefined,
        );
      });
    });

    it('cancels delete when Cancel is clicked', async () => {
      renderSkills();
      await screen.findByText('mission');
      fireEvent.click(screen.getAllByTitle('Delete skill')[0]);
      expect(screen.getByText('Delete skill')).toBeInTheDocument();
      fireEvent.click(screen.getAllByText('Cancel')[0]);
      expect(screen.queryByText('Delete skill')).not.toBeInTheDocument();
    });

    it('disables delete button when disabled prop is true', async () => {
      renderSkills({ disabled: true });
      await screen.findByText('mission');
      const deleteButtons = screen.getAllByTitle('Delete skill');
      expect(deleteButtons[0]).toBeDisabled();
    });
  });

  describe('open folder', () => {
    it('calls showInFolder with skill path', async () => {
      renderSkills();
      await screen.findByText('mission');
      const folderButtons = screen.getAllByTitle('Open in file manager');
      fireEvent.click(folderButtons[0]);
      expect(window.clubhouse.file.showInFolder).toHaveBeenCalledWith('/project/.claude/skills/mission');
    });
  });

  describe('reporting to agent settings', () => {
    it('reports the count and whether an open editor has edits', async () => {
      const onDirtyChange = vi.fn();
      const onCountChange = vi.fn();
      renderSkills({ onDirtyChange, onCountChange });
      await screen.findByText('mission');
      expect(onCountChange).toHaveBeenCalledWith(2);
      expect(onDirtyChange).toHaveBeenLastCalledWith(false);

      fireEvent.click(screen.getByText('mission'));
      await screen.findByText('Edit: mission');
      expect(onDirtyChange).toHaveBeenLastCalledWith(false);
      fireEvent.change(screen.getByTestId('monaco-editor'), { target: { value: '# Changed' } });
      expect(onDirtyChange).toHaveBeenLastCalledWith(true);

      fireEvent.click(screen.getByText('Cancel'));
      await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
    });
  });
});
