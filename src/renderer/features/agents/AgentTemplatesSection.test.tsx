import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentTemplatesSection } from './AgentTemplatesSection';
import type { AgentTemplateEntry } from '../../../shared/types';
import {
  registerPluginAgentTemplate,
  _resetTemplateRegistryForTesting,
} from '../../plugins/plugin-agent-template-registry';

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
    _resetTemplateRegistryForTesting();
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

  describe('plugin template groups', () => {
    it('shows plugin templates grouped by plugin name', async () => {
      registerPluginAgentTemplate('my-plugin', 'My Plugin', {
        name: 'Code Reviewer',
        description: 'Reviews code',
        promptContent: '# Code Reviewer',
      });
      registerPluginAgentTemplate('my-plugin', 'My Plugin', {
        name: 'Test Writer',
        promptContent: '# Test Writer',
      });

      renderSection();
      await screen.findByText('researcher');

      expect(screen.getByText('My Plugin')).toBeInTheDocument();
      expect(screen.getByText('Code Reviewer')).toBeInTheDocument();
      expect(screen.getByText('Test Writer')).toBeInTheDocument();
    });

    it('shows multiple plugin groups separately', async () => {
      registerPluginAgentTemplate('plugin-a', 'Plugin A', {
        name: 'Agent A',
        promptContent: '# A',
      });
      registerPluginAgentTemplate('plugin-b', 'Plugin B', {
        name: 'Agent B',
        promptContent: '# B',
      });

      renderSection();
      await screen.findByText('researcher');

      expect(screen.getByTestId('plugin-template-group-plugin-a')).toBeInTheDocument();
      expect(screen.getByTestId('plugin-template-group-plugin-b')).toBeInTheDocument();
    });

    it('shows description when provided', async () => {
      registerPluginAgentTemplate('my-plugin', 'My Plugin', {
        name: 'Debugger',
        description: 'Finds and fixes bugs',
        promptContent: '# Debugger',
      });

      renderSection();
      await screen.findByText('researcher');

      expect(screen.getByText('Finds and fixes bugs')).toBeInTheDocument();
    });

    it('shows Built-in label when both filesystem and plugin templates exist', async () => {
      registerPluginAgentTemplate('my-plugin', 'My Plugin', {
        name: 'Agent',
        promptContent: '# Agent',
      });

      renderSection();
      await screen.findByText('researcher');

      expect(screen.getByText('Built-in')).toBeInTheDocument();
    });

    it('does not show Built-in label when no plugin templates exist', async () => {
      renderSection();
      await screen.findByText('researcher');

      expect(screen.queryByText('Built-in')).not.toBeInTheDocument();
    });

    it('shows Create button on plugin templates', async () => {
      registerPluginAgentTemplate('my-plugin', 'My Plugin', {
        name: 'Agent',
        promptContent: '# Agent',
      });

      renderSection();
      await screen.findByText('researcher');

      expect(screen.getByTitle('Create agent from this template')).toBeInTheDocument();
    });

    it('calls onCreateFromPluginTemplate when Create is clicked', async () => {
      const handler = vi.fn();
      registerPluginAgentTemplate('my-plugin', 'My Plugin', {
        name: 'Agent',
        promptContent: '# Agent',
      });

      renderSection({ onCreateFromPluginTemplate: handler });
      await screen.findByText('researcher');

      fireEvent.click(screen.getByTitle('Create agent from this template'));
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          pluginId: 'my-plugin',
          pluginName: 'My Plugin',
          template: expect.objectContaining({ name: 'Agent' }),
        }),
      );
    });

    it('disables Create button when disabled', async () => {
      registerPluginAgentTemplate('my-plugin', 'My Plugin', {
        name: 'Agent',
        promptContent: '# Agent',
      });

      renderSection({ disabled: true });
      await screen.findByText('researcher');

      expect(screen.getByTitle('Create agent from this template')).toBeDisabled();
    });
  });
});
