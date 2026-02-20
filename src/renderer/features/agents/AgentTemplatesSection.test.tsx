import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentTemplatesSection } from './AgentTemplatesSection';
import type { AgentTemplateEntry } from '../../../shared/types';

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

const mockTemplates: AgentTemplateEntry[] = [
  { name: 'researcher', path: '/project/.claude/agents/researcher.md' },
  { name: 'reviewer', path: '/project/.claude/agents/reviewer.md' },
];

function renderSection(overrides: Partial<React.ComponentProps<typeof AgentTemplatesSection>> = {}) {
  return render(
    <AgentTemplatesSection
      worktreePath="/project"
      disabled={false}
      refreshKey={0}
      {...overrides}
    />,
  );
}

describe('AgentTemplatesSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.clubhouse.agentSettings.listAgentTemplateFiles = vi.fn().mockResolvedValue(mockTemplates);
    window.clubhouse.agentSettings.readAgentTemplateContent = vi.fn().mockResolvedValue('# Researcher\n\nDoes research.');
    window.clubhouse.agentSettings.writeAgentTemplateContent = vi.fn().mockResolvedValue(undefined);
    window.clubhouse.agentSettings.deleteAgentTemplate = vi.fn().mockResolvedValue(undefined);
    window.clubhouse.file.showInFolder = vi.fn();
  });

  describe('list view', () => {
    it('renders the Agent Definitions heading', async () => {
      renderSection();
      expect(screen.getByText('Agent Definitions')).toBeInTheDocument();
    });

    it('renders template entries after loading', async () => {
      renderSection();
      expect(await screen.findByText('researcher')).toBeInTheDocument();
      expect(screen.getByText('reviewer')).toBeInTheDocument();
    });

    it('renders empty state when no templates exist', async () => {
      window.clubhouse.agentSettings.listAgentTemplateFiles = vi.fn().mockResolvedValue([]);
      renderSection();
      expect(await screen.findByText('No agent definitions found.')).toBeInTheDocument();
    });

    it('renders the + Agent button', async () => {
      renderSection();
      expect(await screen.findByText('+ Agent')).toBeInTheDocument();
    });

    it('shows custom path label', () => {
      renderSection({ pathLabel: '.codex/agents/' });
      expect(screen.getByText('.codex/agents/')).toBeInTheDocument();
    });

    it('shows default path label', () => {
      renderSection();
      expect(screen.getByText('.claude/agents/')).toBeInTheDocument();
    });

    it('disables + Agent button when disabled', async () => {
      renderSection({ disabled: true });
      const btn = await screen.findByText('+ Agent');
      expect(btn).toBeDisabled();
    });
  });

  describe('create flow', () => {
    it('switches to create view on + Agent click', async () => {
      renderSection();
      await screen.findByText('researcher');
      fireEvent.click(screen.getByText('+ Agent'));
      expect(screen.getByText('New Agent Definition')).toBeInTheDocument();
      expect(screen.getByPlaceholderText('agent-name (lowercase, hyphens)')).toBeInTheDocument();
    });

    it('Save button is disabled when name is empty', async () => {
      renderSection();
      await screen.findByText('researcher');
      fireEvent.click(screen.getByText('+ Agent'));
      expect(screen.getByText('Save')).toBeDisabled();
    });

    it('saves new template and returns to list', async () => {
      renderSection();
      await screen.findByText('researcher');
      fireEvent.click(screen.getByText('+ Agent'));
      fireEvent.change(screen.getByPlaceholderText('agent-name (lowercase, hyphens)'), {
        target: { value: 'planner' },
      });
      fireEvent.click(screen.getByText('Save'));

      await waitFor(() => {
        expect(window.clubhouse.agentSettings.writeAgentTemplateContent).toHaveBeenCalledWith(
          '/project', 'planner', expect.any(String), undefined,
        );
      });
    });

    it('Cancel returns to list view', async () => {
      renderSection();
      await screen.findByText('researcher');
      fireEvent.click(screen.getByText('+ Agent'));
      fireEvent.click(screen.getByText('Cancel'));
      expect(await screen.findByText('Agent Definitions')).toBeInTheDocument();
    });
  });

  describe('edit flow', () => {
    it('switches to edit view when template name is clicked', async () => {
      renderSection();
      fireEvent.click(await screen.findByText('researcher'));

      await waitFor(() => {
        expect(window.clubhouse.agentSettings.readAgentTemplateContent).toHaveBeenCalledWith(
          '/project', 'researcher', undefined,
        );
      });
      expect(await screen.findByText('Edit: researcher')).toBeInTheDocument();
    });

    it('saves edited template', async () => {
      renderSection();
      fireEvent.click(await screen.findByText('researcher'));
      await screen.findByText('Edit: researcher');

      fireEvent.click(screen.getByText('Save'));
      await waitFor(() => {
        expect(window.clubhouse.agentSettings.writeAgentTemplateContent).toHaveBeenCalledWith(
          '/project', 'researcher', expect.any(String), undefined,
        );
      });
    });
  });

  describe('delete flow', () => {
    it('shows delete confirmation dialog', async () => {
      renderSection();
      await screen.findByText('researcher');
      fireEvent.click(screen.getAllByTitle('Delete agent definition')[0]);
      expect(screen.getByText('Delete Agent Definition')).toBeInTheDocument();
      expect(screen.getByText(/cannot be undone/)).toBeInTheDocument();
    });

    it('deletes template when confirmed', async () => {
      renderSection();
      await screen.findByText('researcher');
      fireEvent.click(screen.getAllByTitle('Delete agent definition')[0]);
      fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

      await waitFor(() => {
        expect(window.clubhouse.agentSettings.deleteAgentTemplate).toHaveBeenCalledWith(
          '/project', 'researcher', undefined,
        );
      });
    });

    it('cancels delete on Cancel click', async () => {
      renderSection();
      await screen.findByText('researcher');
      fireEvent.click(screen.getAllByTitle('Delete agent definition')[0]);
      fireEvent.click(screen.getAllByText('Cancel')[0]);
      expect(screen.queryByText('Delete Agent Definition')).not.toBeInTheDocument();
    });

    it('disables delete when disabled', async () => {
      renderSection({ disabled: true });
      await screen.findByText('researcher');
      const deleteButtons = screen.getAllByTitle('Delete agent definition');
      expect(deleteButtons[0]).toBeDisabled();
    });
  });

  describe('open folder', () => {
    it('calls showInFolder with template path', async () => {
      renderSection();
      await screen.findByText('researcher');
      fireEvent.click(screen.getAllByTitle('Open in file manager')[0]);
      expect(window.clubhouse.file.showInFolder).toHaveBeenCalledWith('/project/.claude/agents/researcher.md');
    });
  });
});
