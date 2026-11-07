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

  describe('without missions or a reset (#2901)', () => {
    it('offers no default mission and no Reset to defaults: Clubhouse Mode, which used them, was retired', async () => {
      renderSection();
      expect(await screen.findByText('Default agent settings')).toBeInTheDocument();
      expect(screen.queryByText('Default mission')).not.toBeInTheDocument();
      expect(screen.queryByText('Reset to defaults')).not.toBeInTheDocument();
    });
  });

  describe('source control provider', () => {
    it('renders the source control provider dropdown', async () => {
      renderSection();
      expect(await screen.findByText('Source control provider')).toBeInTheDocument();
    });

    it('shows Use app setting when the project has no value', async () => {
      renderSection();
      await screen.findByText('Source control provider');
      expect(screen.getByDisplayValue('Use app setting')).toBeInTheDocument();
    });

    it('loads a saved GitHub value as GitHub, not the app setting', async () => {
      window.clubhouse.agentSettings.readProjectAgentDefaults = vi.fn().mockResolvedValue({ sourceControlProvider: 'github' });
      renderSection();
      await waitFor(() => expect(screen.getByDisplayValue('GitHub (gh CLI)')).toBeInTheDocument());
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

      const select = screen.getByDisplayValue('Use app setting');
      fireEvent.change(select, { target: { value: 'azure-devops' } });

      expect(screen.getByText('Save defaults')).not.toBeDisabled();
    });

    it('saves sourceControlProvider when non-default', async () => {
      renderSection();
      await screen.findByText('Source control provider');

      const select = screen.getByDisplayValue('Use app setting');
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

    it('saves GitHub explicitly when picked, so it wins over an app setting of Azure DevOps', async () => {
      renderSection();
      await screen.findByText('Source control provider');
      fireEvent.change(screen.getByDisplayValue('Use app setting'), { target: { value: 'github' } });
      fireEvent.click(screen.getByText('Save defaults'));
      await waitFor(() => {
        expect(window.clubhouse.agentSettings.writeProjectAgentDefaults).toHaveBeenCalledWith('/project', expect.objectContaining({ sourceControlProvider: 'github' }));
      });
    });

    it('keeps a saved GitHub value on an unrelated save', async () => {
      window.clubhouse.agentSettings.readProjectAgentDefaults = vi.fn().mockResolvedValue({ instructions: 'Default instructions', sourceControlProvider: 'github' });
      renderSection();
      fireEvent.change(await screen.findByDisplayValue('Default instructions'), { target: { value: 'Changed' } });
      fireEvent.click(screen.getByText('Save defaults'));
      await waitFor(() => {
        expect(window.clubhouse.agentSettings.writeProjectAgentDefaults).toHaveBeenCalledWith('/project', expect.objectContaining({ sourceControlProvider: 'github' }));
      });
    });

    it('omits sourceControlProvider when left on Use app setting', async () => {
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

    it('saves Use app setting as no value, after a project value', async () => {
      window.clubhouse.agentSettings.readProjectAgentDefaults = vi.fn().mockResolvedValue({ sourceControlProvider: 'azure-devops' });
      renderSection();
      fireEvent.change(await screen.findByDisplayValue('Azure DevOps (az CLI)'), { target: { value: '' } });
      fireEvent.click(screen.getByText('Save defaults'));
      await waitFor(() => {
        const call = vi.mocked(window.clubhouse.agentSettings.writeProjectAgentDefaults).mock.calls[0];
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

  describe('without personas and conditional blocks (#2901)', () => {
    it('offers no default persona or conditional blocks, and keeps a saved persona and mission on save', async () => {
      window.clubhouse.agentSettings.readProjectAgentDefaults = vi.fn().mockResolvedValue({ instructions: 'Default instructions', persona: 'qa', mission: 'ship' });
      renderSection();
      expect(await screen.findByText('Source control provider')).toBeInTheDocument();
      expect(screen.queryByText('Default persona')).not.toBeInTheDocument();
      expect(screen.queryByText(/controls conditional blocks/)).not.toBeInTheDocument();

      fireEvent.change(screen.getByDisplayValue('Default instructions'), { target: { value: 'Updated' } });
      fireEvent.click(screen.getByText('Save defaults'));
      await waitFor(() => expect(window.clubhouse.agentSettings.writeProjectAgentDefaults).toHaveBeenCalledWith('/project', expect.objectContaining({ persona: 'qa', mission: 'ship' })));
    });
  });
});
