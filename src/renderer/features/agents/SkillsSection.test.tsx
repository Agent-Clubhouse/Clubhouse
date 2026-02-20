import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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

    it('renders the + Skill button', async () => {
      renderSkills();
      expect(await screen.findByText('+ Skill')).toBeInTheDocument();
    });

    it('shows custom path label when provided', () => {
      renderSkills({ pathLabel: '.codex/skills/' });
      expect(screen.getByText('.codex/skills/')).toBeInTheDocument();
    });

    it('shows default path label when not provided', () => {
      renderSkills();
      expect(screen.getByText('.claude/skills/')).toBeInTheDocument();
    });

    it('disables + Skill button when disabled', async () => {
      renderSkills({ disabled: true });
      const btn = await screen.findByText('+ Skill');
      expect(btn).toBeDisabled();
    });
  });

  describe('create flow', () => {
    it('switches to create view on + Skill click', async () => {
      renderSkills();
      await screen.findByText('mission');
      fireEvent.click(screen.getByText('+ Skill'));
      expect(screen.getByText('New Skill')).toBeInTheDocument();
      expect(screen.getByPlaceholderText('skill-name (lowercase, hyphens)')).toBeInTheDocument();
    });

    it('Save button is disabled when skill name is empty', async () => {
      renderSkills();
      await screen.findByText('mission');
      fireEvent.click(screen.getByText('+ Skill'));
      expect(screen.getByText('Save')).toBeDisabled();
    });

    it('Save button enables when skill name is provided', async () => {
      renderSkills();
      await screen.findByText('mission');
      fireEvent.click(screen.getByText('+ Skill'));
      fireEvent.change(screen.getByPlaceholderText('skill-name (lowercase, hyphens)'), {
        target: { value: 'deploy' },
      });
      expect(screen.getByText('Save')).not.toBeDisabled();
    });

    it('saves new skill and returns to list', async () => {
      renderSkills();
      await screen.findByText('mission');
      fireEvent.click(screen.getByText('+ Skill'));
      fireEvent.change(screen.getByPlaceholderText('skill-name (lowercase, hyphens)'), {
        target: { value: 'deploy' },
      });
      fireEvent.click(screen.getByText('Save'));

      await waitFor(() => {
        expect(window.clubhouse.agentSettings.writeSkillContent).toHaveBeenCalledWith(
          '/project',
          'deploy',
          expect.any(String),
          undefined,
        );
      });
    });

    it('Cancel returns to list view', async () => {
      renderSkills();
      await screen.findByText('mission');
      fireEvent.click(screen.getByText('+ Skill'));
      expect(screen.getByText('New Skill')).toBeInTheDocument();
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
          '/project', 'mission', undefined,
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
          '/project', 'mission', expect.any(String), undefined,
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
      expect(screen.getByText('Delete Skill')).toBeInTheDocument();
      expect(screen.getByText(/cannot be undone/)).toBeInTheDocument();
    });

    it('deletes skill when confirmed', async () => {
      renderSkills();
      await screen.findByText('mission');
      fireEvent.click(screen.getAllByTitle('Delete skill')[0]);
      fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

      await waitFor(() => {
        expect(window.clubhouse.agentSettings.deleteSkill).toHaveBeenCalledWith(
          '/project', 'mission', undefined,
        );
      });
    });

    it('cancels delete when Cancel is clicked', async () => {
      renderSkills();
      await screen.findByText('mission');
      fireEvent.click(screen.getAllByTitle('Delete skill')[0]);
      expect(screen.getByText('Delete Skill')).toBeInTheDocument();
      fireEvent.click(screen.getAllByText('Cancel')[0]);
      expect(screen.queryByText('Delete Skill')).not.toBeInTheDocument();
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
});
