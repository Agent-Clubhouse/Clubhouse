import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProjectAgentDefaultsSection } from './ProjectAgentDefaultsSection';
import { getPersonaTemplate } from '../personas';

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

    it('shows Skills section', async () => {
      renderSection();
      expect(await screen.findByText('Skills')).toBeInTheDocument();
    });

    it('shows Agent Definitions section', async () => {
      renderSection();
      expect(await screen.findByText('Agent definitions')).toBeInTheDocument();
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
      fireEvent.click(toggle);
      expect(toggle).toHaveAttribute('aria-checked', 'true');

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
      expect(await screen.findByText(/Clubhouse Mode is on/)).toBeInTheDocument();
      expect(screen.getByText('@@AgentName')).toBeInTheDocument();
      expect(screen.getByText('@@StandbyBranch')).toBeInTheDocument();
      expect(screen.getByText('@@Path')).toBeInTheDocument();
    });

    it('lists @@Mission and @@Persona in the active banner', async () => {
      renderSection({ clubhouseMode: true });
      await screen.findByText(/Clubhouse Mode is on/);
      // Both tokens are mentioned in the banner *and* in helper text under
      // their respective inputs — just assert presence.
      expect(screen.getAllByText('@@Mission').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText('@@Persona').length).toBeGreaterThanOrEqual(1);
    });

    it('references the self-edit guide path when clubhouse mode is on', async () => {
      renderSection({ clubhouseMode: true });
      await screen.findByText(/Clubhouse Mode is on/);
      // Referenced in the banner and again in the persona helper text.
      expect(screen.getAllByText('.clubhouse/clubhouse-mode.md').length).toBeGreaterThanOrEqual(1);
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

  describe('default persona', () => {
    it('renders the Default Persona dropdown', async () => {
      renderSection();
      expect(await screen.findByText('Default persona')).toBeInTheDocument();
    });

    it('loads a saved persona value', async () => {
      window.clubhouse.agentSettings.readProjectAgentDefaults = vi.fn().mockResolvedValue({
        instructions: 'test',
        persona: 'qa',
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
        expect(screen.getByDisplayValue('PR Reviewer')).toBeInTheDocument();
      });
      expect(screen.getByTestId('project-defaults-persona-description').textContent).toBe(getPersonaTemplate('qa')!.description);
    });

    it('saves persona when set', async () => {
      renderSection();
      await screen.findByText('Default persona');
      const select = screen.getByDisplayValue('None') as HTMLSelectElement;
      fireEvent.change(select, { target: { value: 'qa' } });
      fireEvent.click(screen.getByText('Save defaults'));

      await waitFor(() => {
        const call = vi.mocked(window.clubhouse.agentSettings.writeProjectAgentDefaults).mock.calls[0];
        expect(call[1].persona).toBe('qa');
      });
    });

    it('omits persona when left as None', async () => {
      renderSection();
      await screen.findByText('Default persona');
      // Trigger dirty without changing persona
      const textarea = screen.getByDisplayValue('Default instructions');
      fireEvent.change(textarea, { target: { value: 'Updated' } });
      fireEvent.click(screen.getByText('Save defaults'));

      await waitFor(() => {
        const call = vi.mocked(window.clubhouse.agentSettings.writeProjectAgentDefaults).mock.calls[0];
        expect(call[1].persona).toBeUndefined();
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
});
