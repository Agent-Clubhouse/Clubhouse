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
    window.clubhouse.agentSettings.saveProjectUserDefaults = vi.fn().mockResolvedValue(undefined);
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

    it('saves only the changed field (#3244)', async () => {
      renderSection();
      await screen.findByRole('heading', { name: 'Default instructions' });

      // Modify instructions to enable save
      const textarea = screen.getByDisplayValue('Default instructions');
      fireEvent.change(textarea, { target: { value: 'Updated instructions' } });
      fireEvent.click(screen.getByText('Save defaults'));

      await waitFor(() => {
        expect(window.clubhouse.agentSettings.saveProjectUserDefaults).toHaveBeenCalledWith(
          '/project',
          { instructions: 'Updated instructions', freeAgentMode: null },
        );
      });
    });
  });

  describe('access (#2761)', () => {
    it('has no project free agent default, and drops a saved one on save', async () => {
      window.clubhouse.agentSettings.readProjectAgentDefaults = vi.fn().mockResolvedValue({ instructions: 'Default instructions', freeAgentMode: true });
      renderSection();
      await screen.findByRole('heading', { name: 'Default instructions' });
      expect(screen.queryByText(/free agent/i)).not.toBeInTheDocument();
      expect(screen.queryByRole('switch', { name: /free agent/i })).not.toBeInTheDocument();
      fireEvent.change(screen.getByDisplayValue('Default instructions'), { target: { value: 'Updated instructions' } });
      fireEvent.click(screen.getByText('Save defaults'));
      await waitFor(() => expect(window.clubhouse.agentSettings.saveProjectUserDefaults).toHaveBeenCalled());
      const written = vi.mocked(window.clubhouse.agentSettings.saveProjectUserDefaults).mock.calls[0][1] as Record<string, unknown>;
      expect(written).toHaveProperty('freeAgentMode', null);
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
        expect(window.clubhouse.agentSettings.saveProjectUserDefaults).toHaveBeenCalledWith(
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
        expect(window.clubhouse.agentSettings.saveProjectUserDefaults).toHaveBeenCalledWith('/project', expect.objectContaining({ sourceControlProvider: 'github' }));
      });
    });

    it('leaves a saved GitHub value alone on an unrelated save', async () => {
      window.clubhouse.agentSettings.readProjectAgentDefaults = vi.fn().mockResolvedValue({ instructions: 'Default instructions', sourceControlProvider: 'github' });
      renderSection();
      fireEvent.change(await screen.findByDisplayValue('Default instructions'), { target: { value: 'Changed' } });
      fireEvent.click(screen.getByText('Save defaults'));
      await waitFor(() => expect(window.clubhouse.agentSettings.saveProjectUserDefaults).toHaveBeenCalled());
      expect(vi.mocked(window.clubhouse.agentSettings.saveProjectUserDefaults).mock.calls[0][1]).not.toHaveProperty('sourceControlProvider');
    });

    it('omits sourceControlProvider when left on Use app setting', async () => {
      renderSection();
      await screen.findByRole('heading', { name: 'Default instructions' });

      // Change instructions to enable save
      const textarea = screen.getByDisplayValue('Default instructions');
      fireEvent.change(textarea, { target: { value: 'Changed' } });
      fireEvent.click(screen.getByText('Save defaults'));

      await waitFor(() => {
        const call = (window.clubhouse.agentSettings.saveProjectUserDefaults as ReturnType<typeof vi.fn>).mock.calls[0];
        expect(call[1].sourceControlProvider).toBeUndefined();
      });
    });

    it('saves Use app setting as no value, after a project value', async () => {
      window.clubhouse.agentSettings.readProjectAgentDefaults = vi.fn().mockResolvedValue({ sourceControlProvider: 'azure-devops' });
      renderSection();
      fireEvent.change(await screen.findByDisplayValue('Azure DevOps (az CLI)'), { target: { value: '' } });
      fireEvent.click(screen.getByText('Save defaults'));
      await waitFor(() => {
        const call = vi.mocked(window.clubhouse.agentSettings.saveProjectUserDefaults).mock.calls[0];
        expect(call[1].sourceControlProvider).toBeNull();
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
        expect(window.clubhouse.agentSettings.saveProjectUserDefaults).toHaveBeenCalledWith(
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
        const call = (window.clubhouse.agentSettings.saveProjectUserDefaults as ReturnType<typeof vi.fn>).mock.calls[0];
        expect(call[1].commandPrefix).toBeUndefined();
      });
    });
  });

  describe('without personas and conditional blocks (#2901)', () => {
    it('offers no default persona or conditional blocks, and leaves a saved persona and mission alone on save', async () => {
      window.clubhouse.agentSettings.readProjectAgentDefaults = vi.fn().mockResolvedValue({ instructions: 'Default instructions', persona: 'qa', mission: 'ship' });
      renderSection();
      expect(await screen.findByText('Source control provider')).toBeInTheDocument();
      expect(screen.queryByText('Default persona')).not.toBeInTheDocument();
      expect(screen.queryByText(/controls conditional blocks/)).not.toBeInTheDocument();

      fireEvent.change(screen.getByDisplayValue('Default instructions'), { target: { value: 'Updated' } });
      fireEvent.click(screen.getByText('Save defaults'));
      await waitFor(() => expect(window.clubhouse.agentSettings.saveProjectUserDefaults).toHaveBeenCalledWith('/project', { instructions: 'Updated' }));
    });
  });

  describe('provenance, failures and project switches (#3244)', () => {
    const tagged = 'Bash(plugin-cmd) /* plugin:foo */';
    const mcpWithPlugin = JSON.stringify({ mcpServers: { mine: { command: 'a' }, 'plugin-foo-srv': { command: 'p' } } });
    function withPluginParts(): void {
      window.clubhouse.agentSettings.readProjectAgentDefaults = vi.fn().mockResolvedValue({
        instructions: 'Default instructions',
        permissions: { allow: ['Read(**)', tagged], deny: [] },
        mcpJson: mcpWithPlugin,
      });
      window.clubhouse.agentSettings.getProjectConfigBreakdown = vi.fn().mockResolvedValue({
        userInstructions: 'Default instructions',
        pluginInstructionBlocks: [],
        allowRules: [
          { id: 'allow-rule:0', label: 'Read(**)', value: 'Read(**)', provenance: { source: 'user' } },
          { id: 'allow-rule:1', label: 'Bash(plugin-cmd)', value: tagged, provenance: { source: 'plugin', pluginId: 'foo' } },
        ],
        denyRules: [],
        skills: [],
        agentTemplates: [],
        mcpServers: [
          { id: 'mcp:mine', label: 'mine', value: '{}', provenance: { source: 'user' } },
          { id: 'mcp:plugin-foo-srv', label: 'plugin-foo-srv', value: '{}', provenance: { source: 'plugin', pluginId: 'foo' } },
        ],
        orphanedPluginIds: [],
      });
    }
    const allowBox = () => screen.getByLabelText('Allowed tools, one per line') as HTMLTextAreaElement;
    const lastPatch = () => vi.mocked(window.clubhouse.agentSettings.saveProjectUserDefaults).mock.calls.at(-1)![1];

    it('keeps what you type in the permission fields once plugin attribution has loaded', async () => {
      withPluginParts();
      renderSection();
      await waitFor(() => expect(allowBox().value).toBe('Read(**)'));
      fireEvent.change(allowBox(), { target: { value: 'Read(**)\nEdit(**)' } });
      expect(allowBox().value).toBe('Read(**)\nEdit(**)');
      fireEvent.change(screen.getByLabelText('Auto-deny tools, one per line'), { target: { value: 'WebFetch' } });
      expect((screen.getByLabelText('Auto-deny tools, one per line') as HTMLTextAreaElement).value).toBe('WebFetch');
    });

    it('sends only your permission rules, so plugin rules are never added again', async () => {
      withPluginParts();
      renderSection();
      await waitFor(() => expect(allowBox().value).toBe('Read(**)'));
      fireEvent.change(allowBox(), { target: { value: 'Read(**)\nEdit(**)' } });
      fireEvent.click(screen.getByText('Save defaults'));
      await waitFor(() => expect(window.clubhouse.agentSettings.saveProjectUserDefaults).toHaveBeenCalledTimes(1));
      expect(lastPatch()).toEqual({ permissions: { allow: ['Read(**)', 'Edit(**)'], deny: [] } });
    });

    it('shows only your MCP servers and sends only them, leaving plugin servers to the save', async () => {
      withPluginParts();
      renderSection();
      const mcpBox = await screen.findByLabelText('Default .mcp.json') as HTMLTextAreaElement;
      await waitFor(() => expect(JSON.parse(mcpBox.value).mcpServers).toEqual({ mine: { command: 'a' } }));
      const edited = JSON.stringify({ mcpServers: { mine: { command: 'b' } } });
      fireEvent.change(mcpBox, { target: { value: edited } });
      fireEvent.click(screen.getByText('Save defaults'));
      await waitFor(() => expect(window.clubhouse.agentSettings.saveProjectUserDefaults).toHaveBeenCalledTimes(1));
      expect(lastPatch()).toEqual({ mcpJson: edited });
    });

    it('shows why a save failed and enables Save again', async () => {
      window.clubhouse.agentSettings.saveProjectUserDefaults = vi.fn().mockRejectedValue(
        new Error("Error invoking remote method 'agent:save-project-user-defaults': Error: Command prefix can't contain a newline"),
      );
      renderSection();
      fireEvent.change(await screen.findByPlaceholderText('. ./init.sh'), { target: { value: 'bad' } });
      fireEvent.click(screen.getByText('Save defaults'));
      expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't save defaults. Command prefix can't contain a newline");
      expect(screen.getByText('Save defaults')).not.toBeDisabled();
      expect(screen.getByPlaceholderText('. ./init.sh')).toHaveValue('bad');
    });

    it('drops the previous project\'s edits on a project switch, and offers no Save when the new one fails to load', async () => {
      const { rerender } = renderSection();
      fireEvent.change(await screen.findByDisplayValue('Default instructions'), { target: { value: 'Typed for project A' } });
      window.clubhouse.agentSettings.readProjectAgentDefaults = vi.fn().mockRejectedValue(new Error('disk on fire'));
      rerender(<ProjectAgentDefaultsSection projectPath="/project-b" />);
      expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load this project's default agent settings. disk on fire");
      expect(screen.queryByDisplayValue('Typed for project A')).not.toBeInTheDocument();
      expect(screen.queryByText('Save defaults')).not.toBeInTheDocument();
      expect(window.clubhouse.agentSettings.saveProjectUserDefaults).not.toHaveBeenCalled();
    });

    it('shows the new project\'s values after a switch', async () => {
      const { rerender } = renderSection();
      fireEvent.change(await screen.findByDisplayValue('Default instructions'), { target: { value: 'Typed for project A' } });
      window.clubhouse.agentSettings.readProjectAgentDefaults = vi.fn().mockResolvedValue({ buildCommand: 'make b' });
      window.clubhouse.agentSettings.getProjectConfigBreakdown = vi.fn().mockRejectedValue(new Error('no breakdown'));
      rerender(<ProjectAgentDefaultsSection projectPath="/project-b" />);
      expect(await screen.findByDisplayValue('make b')).toBeInTheDocument();
      expect(screen.queryByDisplayValue('Typed for project A')).not.toBeInTheDocument();
      expect(screen.getByText('Save defaults')).toBeDisabled();
    });

    it('saves only changed fields, so a newer helper routing change survives', async () => {
      renderSection();
      fireEvent.change(await screen.findByPlaceholderText('npm run build'), { target: { value: 'make' } });
      fireEvent.click(screen.getByText('Save defaults'));
      await waitFor(() => expect(window.clubhouse.agentSettings.saveProjectUserDefaults).toHaveBeenCalledTimes(1));
      expect(lastPatch()).toEqual({ buildCommand: 'make', freeAgentMode: null });
      expect(lastPatch()).not.toHaveProperty('helperAuto');
    });
  });
});
