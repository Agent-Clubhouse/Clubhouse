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
    window.clubhouse.agentSettings.getProjectConfigBreakdown = vi.fn().mockResolvedValue({
      userInstructions: 'Default instructions',
      pluginInstructionBlocks: [],
      allowRules: [
        { id: 'allow-rule:0', label: 'Read(**)', value: 'Read(**)', provenance: { source: 'user' } },
        { id: 'allow-rule:1', label: 'Edit(**)', value: 'Edit(**)', provenance: { source: 'user' } },
      ],
      denyRules: [
        { id: 'deny-rule:0', label: 'WebFetch', value: 'WebFetch', provenance: { source: 'user' } },
      ],
      skills: [],
      agentTemplates: [],
      mcpServers: [],
      orphanedPluginIds: [],
    });
    window.clubhouse.agentSettings.removePluginInjectionItem = vi.fn().mockResolvedValue(true);
    // Mock plugin cleanup API (used by OrphanBanner)
    if (!window.clubhouse.plugin) {
      (window.clubhouse as any).plugin = {};
    }
    window.clubhouse.plugin.cleanupProjectInjections = vi.fn().mockResolvedValue(undefined);
  });

  describe('always-visible state', () => {
    it('renders the Default Agent Settings header', async () => {
      renderSection();
      expect(await screen.findByText('Default agent settings')).toBeInTheDocument();
    });

    it('shows form fields without needing to expand', async () => {
      renderSection();
      expect(await screen.findByRole('heading', { name: 'Default instructions' })).toBeInTheDocument();
      expect(screen.getByText('Default permissions')).toBeInTheDocument();
      expect(screen.getByText('Default .mcp.json')).toBeInTheDocument();
      expect(screen.getByText('Free agent mode by default')).toBeInTheDocument();
    });

    it('shows Save button always', async () => {
      renderSection();
      expect(await screen.findByText('Save defaults')).toBeInTheDocument();
    });

    it('has no project skills or agent definitions sections (#2901)', async () => {
      renderSection();
      await screen.findByText('Default agent settings');
      expect(screen.queryByText('Skills')).not.toBeInTheDocument();
      expect(screen.queryByText('Agent definitions')).not.toBeInTheDocument();
      expect(screen.queryByText('Managed skills')).not.toBeInTheDocument();
    });
  });

  describe('form fields', () => {
    it('loads and displays existing defaults', async () => {
      renderSection();
      await waitFor(() => {
        expect(screen.getByDisplayValue('Default instructions')).toBeInTheDocument();
      });
    });

    it('Save defaults is disabled when not dirty', async () => {
      renderSection();
      const btn = await screen.findByText('Save defaults');
      expect(btn).toBeDisabled();
    });
  });

  describe('editing and saving', () => {
    it('enables Save when instructions change', async () => {
      renderSection();
      await screen.findByRole('heading', { name: 'Default instructions' });

      const textarea = screen.getByDisplayValue('Default instructions');
      fireEvent.change(textarea, { target: { value: 'Updated instructions' } });

      expect(screen.getByText('Save defaults')).not.toBeDisabled();
    });

    it('saves all fields on Save click', async () => {
      renderSection();
      await screen.findByRole('heading', { name: 'Default instructions' });

      // Modify instructions to enable save
      const textarea = screen.getByDisplayValue('Default instructions');
      fireEvent.change(textarea, { target: { value: 'Updated instructions' } });
      fireEvent.click(screen.getByText('Save defaults'));

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
      await screen.findByText('Free agent mode by default');

      const toggle = screen.getByRole('switch', { name: 'Free agent mode by default' });
      expect(toggle).toHaveAttribute('aria-checked', 'false');
      expect(screen.getByText('Start new agents with the configured Free agent permission mode.')).toBeInTheDocument();
      fireEvent.click(toggle);
      expect(toggle).toHaveAttribute('aria-checked', 'true');

      expect(await screen.findByText(/configured Free agent permission mode/)).toBeInTheDocument();
    });
  });

  describe('intro', () => {
    it('says the defaults are snapshots for new agents, with no Clubhouse Mode wildcard list', async () => {
      renderSection();
      expect(await screen.findByText(/snapshots when new durable agents/)).toBeInTheDocument();
      expect(screen.queryByText(/still use Clubhouse Mode/)).not.toBeInTheDocument();
      expect(screen.queryByText('@@AgentName')).not.toBeInTheDocument();
      expect(screen.queryByText('.clubhouse/clubhouse-mode.md')).not.toBeInTheDocument();
    });
  });

  describe('default mission', () => {
    it('renders the Default Mission input', async () => {
      renderSection();
      expect(await screen.findByText('Default mission')).toBeInTheDocument();
    });

    it('loads a saved mission value', async () => {
      window.clubhouse.agentSettings.readProjectAgentDefaults = vi.fn().mockResolvedValue({
        instructions: 'test',
        mission: 'implement-and-ship',
      });
      window.clubhouse.agentSettings.getProjectConfigBreakdown = vi.fn().mockResolvedValue({
        userInstructions: 'test',
        pluginInstructionBlocks: [],
        allowRules: [],
        denyRules: [],
        skills: [],
        agentTemplates: [],
        mcpServers: [],
        orphanedPluginIds: [],
      });
      renderSection();
      await waitFor(() => {
        expect(screen.getByDisplayValue('implement-and-ship')).toBeInTheDocument();
      });
    });

    it('saves mission when set', async () => {
      renderSection();
      const input = await screen.findByPlaceholderText('implement-and-ship');
      fireEvent.change(input, { target: { value: 'my-mission' } });
      fireEvent.click(screen.getByText('Save defaults'));

      await waitFor(() => {
        const call = vi.mocked(window.clubhouse.agentSettings.writeProjectAgentDefaults).mock.calls[0];
        expect(call[1].mission).toBe('my-mission');
      });
    });

    it('omits mission when left blank', async () => {
      renderSection();
      await screen.findByText('Default mission');
      // Trigger dirty without setting mission
      const textarea = screen.getByDisplayValue('Default instructions');
      fireEvent.change(textarea, { target: { value: 'Updated' } });
      fireEvent.click(screen.getByText('Save defaults'));

      await waitFor(() => {
        const call = vi.mocked(window.clubhouse.agentSettings.writeProjectAgentDefaults).mock.calls[0];
        expect(call[1].mission).toBeUndefined();
      });
    });
  });

  describe('source control provider', () => {
    it('renders the source control provider dropdown', async () => {
      renderSection();
      expect(await screen.findByText('Source control provider')).toBeInTheDocument();
    });

    it('defaults to GitHub', async () => {
      renderSection();
      await screen.findByText('Source control provider');

      const select = screen.getByDisplayValue('GitHub (gh CLI)');
      expect(select).toBeInTheDocument();
    });

    it('loads azure-devops from saved defaults', async () => {
      window.clubhouse.agentSettings.readProjectAgentDefaults = vi.fn().mockResolvedValue({
        instructions: 'test',
        sourceControlProvider: 'azure-devops',
      });
      window.clubhouse.agentSettings.getProjectConfigBreakdown = vi.fn().mockResolvedValue({
        userInstructions: 'test',
        pluginInstructionBlocks: [],
        allowRules: [],
        denyRules: [],
        skills: [],
        agentTemplates: [],
        mcpServers: [],
        orphanedPluginIds: [],
      });
      renderSection();
      await waitFor(() => {
        expect(screen.getByDisplayValue('Azure DevOps (az CLI)')).toBeInTheDocument();
      });
    });

    it('marks dirty when provider changes', async () => {
      renderSection();
      await screen.findByText('Source control provider');

      const select = screen.getByDisplayValue('GitHub (gh CLI)');
      fireEvent.change(select, { target: { value: 'azure-devops' } });

      expect(screen.getByText('Save defaults')).not.toBeDisabled();
    });

    it('saves sourceControlProvider when non-default', async () => {
      renderSection();
      await screen.findByText('Source control provider');

      const select = screen.getByDisplayValue('GitHub (gh CLI)');
      fireEvent.change(select, { target: { value: 'azure-devops' } });
      fireEvent.click(screen.getByText('Save defaults'));

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
      await screen.findByRole('heading', { name: 'Default instructions' });

      // Change instructions to enable save
      const textarea = screen.getByDisplayValue('Default instructions');
      fireEvent.change(textarea, { target: { value: 'Changed' } });
      fireEvent.click(screen.getByText('Save defaults'));

      await waitFor(() => {
        const call = (window.clubhouse.agentSettings.writeProjectAgentDefaults as ReturnType<typeof vi.fn>).mock.calls[0];
        expect(call[1].sourceControlProvider).toBeUndefined();
      });
    });
  });

  describe('command prefix', () => {
    it('renders the Command Prefix input', async () => {
      renderSection();
      expect(await screen.findByText('Command prefix')).toBeInTheDocument();
    });

    it('loads and displays existing command prefix', async () => {
      window.clubhouse.agentSettings.readProjectAgentDefaults = vi.fn().mockResolvedValue({
        commandPrefix: '. ./init.sh',
      });
      window.clubhouse.agentSettings.getProjectConfigBreakdown = vi.fn().mockResolvedValue({
        userInstructions: '',
        pluginInstructionBlocks: [],
        allowRules: [],
        denyRules: [],
        skills: [],
        agentTemplates: [],
        mcpServers: [],
        orphanedPluginIds: [],
      });
      renderSection();
      await waitFor(() => {
        expect(screen.getByDisplayValue('. ./init.sh')).toBeInTheDocument();
      });
    });

    it('marks dirty when command prefix changes', async () => {
      renderSection();
      await screen.findByText('Command prefix');

      const input = screen.getByPlaceholderText('. ./init.sh');
      fireEvent.change(input, { target: { value: '. ./setup.sh' } });

      expect(screen.getByText('Save defaults')).not.toBeDisabled();
    });

    it('saves commandPrefix when set', async () => {
      renderSection();
      await screen.findByText('Command prefix');

      const input = screen.getByPlaceholderText('. ./init.sh');
      fireEvent.change(input, { target: { value: '. ./setup.sh' } });
      fireEvent.click(screen.getByText('Save defaults'));

      await waitFor(() => {
        expect(window.clubhouse.agentSettings.writeProjectAgentDefaults).toHaveBeenCalledWith(
          '/project',
          expect.objectContaining({
            commandPrefix: '. ./setup.sh',
          }),
        );
      });
    });

    it('omits commandPrefix when empty', async () => {
      renderSection();
      await screen.findByRole('heading', { name: 'Default instructions' });

      // Change instructions to enable save
      const textarea = screen.getByDisplayValue('Default instructions');
      fireEvent.change(textarea, { target: { value: 'Changed' } });
      fireEvent.click(screen.getByText('Save defaults'));

      await waitFor(() => {
        const call = (window.clubhouse.agentSettings.writeProjectAgentDefaults as ReturnType<typeof vi.fn>).mock.calls[0];
        expect(call[1].commandPrefix).toBeUndefined();
      });
    });
  });

  describe('reset to defaults', () => {
    it('renders the Reset to defaults button', async () => {
      renderSection();
      expect(await screen.findByText('Reset to defaults')).toBeInTheDocument();
    });

    it('shows confirmation dialog on click', async () => {
      renderSection();
      fireEvent.click(await screen.findByText('Reset to defaults'));
      expect(screen.getByText('Reset to defaults?')).toBeInTheDocument();
      expect(screen.getByText(/replaces every project-level agent default/)).toBeInTheDocument();
    });

    it('cancels confirmation dialog', async () => {
      renderSection();
      fireEvent.click(await screen.findByText('Reset to defaults'));
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByText('Reset to defaults?')).not.toBeInTheDocument();
    });

    it('calls resetProjectAgentDefaults and reloads on confirm', async () => {
      window.clubhouse.agentSettings.resetProjectAgentDefaults = vi.fn().mockResolvedValue(undefined);
      // After reset, readProjectAgentDefaults returns fresh defaults
      const readMock = vi.fn()
        .mockResolvedValueOnce({
          instructions: 'Custom instructions',
          permissions: { allow: ['Read(**)'] },
        })
        .mockResolvedValueOnce({
          instructions: 'Default @@AgentName instructions',
          permissions: { allow: ['Read(@@Path**)'] },
        });
      window.clubhouse.agentSettings.readProjectAgentDefaults = readMock;
      window.clubhouse.agentSettings.getProjectConfigBreakdown = vi.fn().mockResolvedValue({
        userInstructions: 'Custom instructions',
        pluginInstructionBlocks: [],
        allowRules: [{ id: 'allow-rule:0', label: 'Read(**)', value: 'Read(**)', provenance: { source: 'user' } }],
        denyRules: [],
        skills: [],
        agentTemplates: [],
        mcpServers: [],
        orphanedPluginIds: [],
      });

      renderSection();
      await screen.findByText('Default agent settings');
      fireEvent.click(screen.getByText('Reset to defaults'));
      fireEvent.click(screen.getByRole('button', { name: 'Reset' }));

      await waitFor(() => {
        expect(window.clubhouse.agentSettings.resetProjectAgentDefaults).toHaveBeenCalledWith('/project');
      });
      // Verify it reloaded defaults
      await waitFor(() => {
        expect(readMock).toHaveBeenCalledTimes(2);
      });
    });
  });

  describe('loading states', () => {
    it('returns null before loading completes', () => {
      window.clubhouse.agentSettings.readProjectAgentDefaults = vi.fn().mockReturnValue(new Promise(() => {}));
      window.clubhouse.agentSettings.getProjectConfigBreakdown = vi.fn().mockReturnValue(new Promise(() => {}));
      const { container } = renderSection();
      expect(container.innerHTML).toBe('');
    });

    it('renders after load error', async () => {
      window.clubhouse.agentSettings.readProjectAgentDefaults = vi.fn().mockRejectedValue(new Error('fail'));
      window.clubhouse.agentSettings.getProjectConfigBreakdown = vi.fn().mockRejectedValue(new Error('fail'));
      renderSection();
      expect(await screen.findByText('Default agent settings')).toBeInTheDocument();
    });
  });

  describe('without personas and conditional blocks (#2901)', () => {
    it('offers no default persona or conditional blocks, and keeps a saved persona on save', async () => {
      window.clubhouse.agentSettings.readProjectAgentDefaults = vi.fn().mockResolvedValue({ instructions: 'Default instructions', persona: 'qa' });
      renderSection();
      expect(await screen.findByText('Source control provider')).toBeInTheDocument();
      expect(screen.queryByText('Default persona')).not.toBeInTheDocument();
      expect(screen.queryByText(/controls conditional blocks/)).not.toBeInTheDocument();

      fireEvent.change(screen.getByPlaceholderText('implement-and-ship'), { target: { value: 'ship' } });
      fireEvent.click(screen.getByText('Save defaults'));
      await waitFor(() => expect(window.clubhouse.agentSettings.writeProjectAgentDefaults).toHaveBeenCalledWith('/project', expect.objectContaining({ persona: 'qa', mission: 'ship' })));
    });
  });
});
