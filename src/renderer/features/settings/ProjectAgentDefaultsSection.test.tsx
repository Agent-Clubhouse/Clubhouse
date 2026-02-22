import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProjectAgentDefaultsSection } from './ProjectAgentDefaultsSection';

function renderSection(overrides: Partial<React.ComponentProps<typeof ProjectAgentDefaultsSection>> = {}) {
  return render(
    <ProjectAgentDefaultsSection
      projectPath="/project"
      {...overrides}
    />,
  );
}

describe('ProjectAgentDefaultsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.clubhouse.agentSettings.readProjectAgentDefaults = vi.fn().mockResolvedValue({
      instructions: 'Default instructions',
      permissions: { allow: ['Read(**)', 'Edit(**)'], deny: ['WebFetch'] },
      mcpJson: '{"mcpServers": {}}',
      freeAgentMode: false,
    });
    window.clubhouse.agentSettings.writeProjectAgentDefaults = vi.fn().mockResolvedValue(undefined);
    window.clubhouse.agentSettings.listSourceSkills = vi.fn().mockResolvedValue([]);
    window.clubhouse.agentSettings.listSourceAgentTemplates = vi.fn().mockResolvedValue([]);
  });

  describe('always-visible state', () => {
    it('renders the Default Agent Settings header', async () => {
      renderSection();
      expect(await screen.findByText('Default Agent Settings')).toBeInTheDocument();
    });

    it('shows form fields without needing to expand', async () => {
      renderSection();
      expect(await screen.findByText('Default Instructions')).toBeInTheDocument();
      expect(screen.getByText('Default Permissions')).toBeInTheDocument();
      expect(screen.getByText('Default .mcp.json')).toBeInTheDocument();
      expect(screen.getByText('Free Agent Mode by default')).toBeInTheDocument();
    });

    it('shows Save button always', async () => {
      renderSection();
      expect(await screen.findByText('Save Defaults')).toBeInTheDocument();
    });

    it('shows Skills section', async () => {
      renderSection();
      expect(await screen.findByText('Skills')).toBeInTheDocument();
    });

    it('shows Agent Definitions section', async () => {
      renderSection();
      expect(await screen.findByText('Agent Definitions')).toBeInTheDocument();
    });
  });

  describe('form fields', () => {
    it('loads and displays existing defaults', async () => {
      renderSection();
      await waitFor(() => {
        expect(screen.getByDisplayValue('Default instructions')).toBeInTheDocument();
      });
    });

    it('Save Defaults is disabled when not dirty', async () => {
      renderSection();
      const btn = await screen.findByText('Save Defaults');
      expect(btn).toBeDisabled();
    });
  });

  describe('editing and saving', () => {
    it('enables Save when instructions change', async () => {
      renderSection();
      await screen.findByText('Default Instructions');

      const textarea = screen.getByDisplayValue('Default instructions');
      fireEvent.change(textarea, { target: { value: 'Updated instructions' } });

      expect(screen.getByText('Save Defaults')).not.toBeDisabled();
    });

    it('saves all fields on Save click', async () => {
      renderSection();
      await screen.findByText('Default Instructions');

      // Modify instructions to enable save
      const textarea = screen.getByDisplayValue('Default instructions');
      fireEvent.change(textarea, { target: { value: 'Updated instructions' } });
      fireEvent.click(screen.getByText('Save Defaults'));

      await waitFor(() => {
        expect(window.clubhouse.agentSettings.writeProjectAgentDefaults).toHaveBeenCalledWith(
          '/project',
          expect.objectContaining({
            instructions: 'Updated instructions',
            permissions: { allow: ['Read(**)', 'Edit(**)'], deny: ['WebFetch'] },
          }),
        );
      });
    });
  });

  describe('free agent mode', () => {
    it('shows warning when free agent mode is enabled', async () => {
      renderSection();
      await screen.findByText('Free Agent Mode by default');

      const checkbox = screen.getByRole('checkbox');
      fireEvent.click(checkbox);

      expect(await screen.findByText(/skip all permission prompts/)).toBeInTheDocument();
    });
  });

  describe('clubhouse mode banner', () => {
    it('shows snapshot note when clubhouse mode is off', async () => {
      renderSection({ clubhouseMode: false });
      expect(await screen.findByText(/snapshots when new durable agents/)).toBeInTheDocument();
    });

    it('shows clubhouse mode active banner when on', async () => {
      renderSection({ clubhouseMode: true });
      expect(await screen.findByText(/Clubhouse Mode active/)).toBeInTheDocument();
      expect(screen.getByText('@@AgentName')).toBeInTheDocument();
      expect(screen.getByText('@@StandbyBranch')).toBeInTheDocument();
      expect(screen.getByText('@@Path')).toBeInTheDocument();
    });
  });

  describe('source control provider', () => {
    it('renders the source control provider dropdown', async () => {
      renderSection();
      expect(await screen.findByText('Source Control Provider')).toBeInTheDocument();
    });

    it('defaults to GitHub', async () => {
      renderSection();
      await screen.findByText('Source Control Provider');

      const select = screen.getByDisplayValue('GitHub (gh CLI)');
      expect(select).toBeInTheDocument();
    });

    it('loads azure-devops from saved defaults', async () => {
      window.clubhouse.agentSettings.readProjectAgentDefaults = vi.fn().mockResolvedValue({
        instructions: 'test',
        sourceControlProvider: 'azure-devops',
      });
      renderSection();
      await waitFor(() => {
        expect(screen.getByDisplayValue('Azure DevOps (az CLI)')).toBeInTheDocument();
      });
    });

    it('marks dirty when provider changes', async () => {
      renderSection();
      await screen.findByText('Source Control Provider');

      const select = screen.getByDisplayValue('GitHub (gh CLI)');
      fireEvent.change(select, { target: { value: 'azure-devops' } });

      expect(screen.getByText('Save Defaults')).not.toBeDisabled();
    });

    it('saves sourceControlProvider when non-default', async () => {
      renderSection();
      await screen.findByText('Source Control Provider');

      const select = screen.getByDisplayValue('GitHub (gh CLI)');
      fireEvent.change(select, { target: { value: 'azure-devops' } });
      fireEvent.click(screen.getByText('Save Defaults'));

      await waitFor(() => {
        expect(window.clubhouse.agentSettings.writeProjectAgentDefaults).toHaveBeenCalledWith(
          '/project',
          expect.objectContaining({
            sourceControlProvider: 'azure-devops',
          }),
        );
      });
    });

    it('omits sourceControlProvider when set to github (default)', async () => {
      renderSection();
      await screen.findByText('Default Instructions');

      // Change instructions to enable save
      const textarea = screen.getByDisplayValue('Default instructions');
      fireEvent.change(textarea, { target: { value: 'Changed' } });
      fireEvent.click(screen.getByText('Save Defaults'));

      await waitFor(() => {
        const call = (window.clubhouse.agentSettings.writeProjectAgentDefaults as ReturnType<typeof vi.fn>).mock.calls[0];
        expect(call[1].sourceControlProvider).toBeUndefined();
      });
    });
  });

  describe('loading states', () => {
    it('returns null before loading completes', () => {
      window.clubhouse.agentSettings.readProjectAgentDefaults = vi.fn().mockReturnValue(new Promise(() => {}));
      const { container } = renderSection();
      expect(container.innerHTML).toBe('');
    });

    it('renders after load error', async () => {
      window.clubhouse.agentSettings.readProjectAgentDefaults = vi.fn().mockRejectedValue(new Error('fail'));
      renderSection();
      expect(await screen.findByText('Default Agent Settings')).toBeInTheDocument();
    });
  });
});
