import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProjectAgentDefaultsSection } from './ProjectAgentDefaultsSection';
import type { LegacyDefaultsSummary } from '../../../shared/legacy-defaults-types';

function renderSection(overrides: Partial<React.ComponentProps<typeof ProjectAgentDefaultsSection>> = {}) {
  return render(
    <ProjectAgentDefaultsSection
      projectPath="/project"
      {...overrides}
    />,
  );
}

const NO_LEGACY: LegacyDefaultsSummary = {
  hasValues: false, instructions: '', pluginInstructions: [], permissions: { allow: [], deny: [] },
  mcpServers: [], mcpJsonValid: true, mcpJson: '', commands: {}, inheritingMcp: [], plainAgents: [],
};

const LEGACY: LegacyDefaultsSummary = {
  hasValues: true,
  instructions: 'Default instructions',
  pluginInstructions: [],
  permissions: { allow: ['Read(**)', 'Edit(**)'], deny: ['WebFetch'] },
  mcpServers: [{ key: 'docs' }],
  mcpJsonValid: true,
  mcpJson: '{"mcpServers":{"docs":{"command":"docs-mcp"}}}',
  commands: { buildCommand: 'make' },
  inheritingMcp: [{ id: 'a1', name: 'scout' }],
  plainAgents: [{ id: 'a1', name: 'scout', cli: 'Claude Code' }, { id: 'a2', name: 'pilot', cli: 'Copilot CLI' }],
};

const breakdown = (over: Record<string, unknown> = {}) => ({
  userInstructions: '', pluginInstructionBlocks: [], allowRules: [], denyRules: [],
  skills: [], agentTemplates: [], mcpServers: [], orphanedPluginIds: [], ...over,
});

describe('ProjectAgentDefaultsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.clubhouse.agentSettings.readProjectAgentDefaults = vi.fn().mockResolvedValue({
      instructions: 'Default instructions',
      permissions: { allow: ['Read(**)'], deny: [] },
      mcpJson: '{"mcpServers": {}}',
    });
    window.clubhouse.agentSettings.saveProjectUserDefaults = vi.fn().mockResolvedValue(undefined);
    window.clubhouse.agentSettings.getProjectConfigBreakdown = vi.fn().mockResolvedValue(breakdown());
    window.clubhouse.agentSettings.removePluginInjectionItem = vi.fn().mockResolvedValue(true);
    window.clubhouse.legacyDefaults.describe = vi.fn().mockResolvedValue(LEGACY);
    window.clubhouse.legacyDefaults.previewImport = vi.fn().mockResolvedValue({ parts: [], notes: [] });
    window.clubhouse.legacyDefaults.importAsParts = vi.fn().mockResolvedValue({ created: [], existing: [], notes: [] });
    window.clubhouse.legacyDefaults.previewCopy = vi.fn().mockResolvedValue({ agentName: 'scout', cli: 'Claude Code', changes: [], blocked: null });
    window.clubhouse.legacyDefaults.copyIntoAgent = vi.fn().mockResolvedValue({ agentName: 'scout', cli: 'Claude Code', changes: [], blocked: null });
    if (!window.clubhouse.plugin) {
      (window.clubhouse as any).plugin = {};
    }
    window.clubhouse.plugin.cleanupProjectInjections = vi.fn().mockResolvedValue(undefined);
  });

  describe('agent environment (#3245)', () => {
    it('edits only the environment, with Save off until something changes', async () => {
      renderSection();
      expect(await screen.findByText('Agent environment')).toBeInTheDocument();
      expect(screen.getByText('Source control provider')).toBeInTheDocument();
      expect(screen.getByText('Command prefix')).toBeInTheDocument();
      expect(screen.getByTestId('project-helper-auto-off')).toBeInTheDocument();
      expect(screen.getByText('Save')).toBeDisabled();
    });

    it('offers no editor for instructions, permissions, MCP JSON or commands', async () => {
      renderSection();
      await screen.findByText('Agent environment');
      expect(screen.queryByRole('textbox', { name: 'Default instructions' })).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Allowed tools, one per line')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Default .mcp.json')).not.toBeInTheDocument();
      expect(screen.queryByPlaceholderText('npm run build')).not.toBeInTheDocument();
      expect(screen.queryByDisplayValue('Default instructions')).not.toBeInTheDocument();
    });

    it('offers no persona, mission, Reset or free agent default (#2901, #2761)', async () => {
      renderSection();
      await screen.findByText('Agent environment');
      expect(screen.queryByText('Default persona')).not.toBeInTheDocument();
      expect(screen.queryByText('Default mission')).not.toBeInTheDocument();
      expect(screen.queryByText('Reset to defaults')).not.toBeInTheDocument();
      expect(screen.queryByText(/free agent/i)).not.toBeInTheDocument();
    });

    it('saves only the changed field, never a legacy one, and drops a saved free agent default (#3244)', async () => {
      window.clubhouse.agentSettings.readProjectAgentDefaults = vi.fn().mockResolvedValue({ instructions: 'x', persona: 'qa', freeAgentMode: true });
      renderSection();
      fireEvent.change(await screen.findByPlaceholderText('. ./init.sh'), { target: { value: '. ./setup.sh' } });
      fireEvent.click(screen.getByText('Save'));
      await waitFor(() => expect(window.clubhouse.agentSettings.saveProjectUserDefaults).toHaveBeenCalledWith(
        '/project', { commandPrefix: '. ./setup.sh', freeAgentMode: null },
      ));
    });

    it('saves the source control provider, and Use app setting as no value', async () => {
      window.clubhouse.agentSettings.readProjectAgentDefaults = vi.fn().mockResolvedValue({ sourceControlProvider: 'azure-devops' });
      renderSection();
      fireEvent.change(await screen.findByDisplayValue('Azure DevOps (az CLI)'), { target: { value: '' } });
      fireEvent.click(screen.getByText('Save'));
      await waitFor(() => expect(window.clubhouse.agentSettings.saveProjectUserDefaults).toHaveBeenCalledWith('/project', { sourceControlProvider: null }));
    });

    it('saves GitHub explicitly, so it wins over an app setting of Azure DevOps', async () => {
      renderSection();
      fireEvent.change(await screen.findByDisplayValue('Use app setting'), { target: { value: 'github' } });
      fireEvent.click(screen.getByText('Save'));
      await waitFor(() => expect(window.clubhouse.agentSettings.saveProjectUserDefaults).toHaveBeenCalledWith('/project', { sourceControlProvider: 'github' }));
    });

    it('saves turning Auto provider off', async () => {
      renderSection();
      fireEvent.click(await screen.findByTestId('project-helper-auto-off'));
      fireEvent.click(screen.getByText('Save'));
      await waitFor(() => expect(window.clubhouse.agentSettings.saveProjectUserDefaults).toHaveBeenCalledWith('/project', { helperAuto: 'off' }));
    });

    it('shows why a save failed and enables Save again', async () => {
      window.clubhouse.agentSettings.saveProjectUserDefaults = vi.fn().mockRejectedValue(
        new Error("Error invoking remote method 'agent:save-project-user-defaults': Error: Command prefix can't contain a newline"),
      );
      renderSection();
      fireEvent.change(await screen.findByPlaceholderText('. ./init.sh'), { target: { value: 'bad' } });
      fireEvent.click(screen.getByText('Save'));
      expect(await screen.findByText(/Couldn't save\. Command prefix can't contain a newline/)).toBeInTheDocument();
      expect(screen.getByText('Save')).not.toBeDisabled();
      expect(screen.getByPlaceholderText('. ./init.sh')).toHaveValue('bad');
    });

    it('drops the previous project\'s edits on a project switch, and offers no Save when the new one fails to load', async () => {
      const { rerender } = renderSection();
      fireEvent.change(await screen.findByPlaceholderText('. ./init.sh'), { target: { value: 'typed for A' } });
      window.clubhouse.agentSettings.readProjectAgentDefaults = vi.fn().mockRejectedValue(new Error('disk on fire'));
      rerender(<ProjectAgentDefaultsSection projectPath="/project-b" />);
      expect(await screen.findByText(/Couldn't load this project's default agent settings\. disk on fire/)).toBeInTheDocument();
      expect(screen.queryByDisplayValue('typed for A')).not.toBeInTheDocument();
      expect(screen.queryByText('Save')).not.toBeInTheDocument();
      expect(window.clubhouse.agentSettings.saveProjectUserDefaults).not.toHaveBeenCalled();
    });
  });

  describe('legacy defaults (#3245)', () => {
    it('shows the saved values read-only, with where the MCP servers still apply', async () => {
      renderSection();
      const section = await screen.findByTestId('legacy-defaults-section');
      expect(within(section).getByText('Default instructions')).toBeInTheDocument();
      expect(within(section).getByText('Read(**)')).toBeInTheDocument();
      expect(within(section).getByText('WebFetch')).toBeInTheDocument();
      expect(within(section).getByText(/docs-mcp/)).toBeInTheDocument();
      expect(within(section).getByText('make')).toBeInTheDocument();
      expect(within(section).getByTestId('legacy-mcp-reach')).toHaveTextContent('Still given at start to scout, plain agent without an MCP file of its own.');
      expect(within(section).queryAllByRole('textbox')).toHaveLength(0);
    });

    it('isn\'t shown when the project has no legacy values', async () => {
      window.clubhouse.legacyDefaults.describe = vi.fn().mockResolvedValue(NO_LEGACY);
      renderSection();
      await screen.findByText('Agent environment');
      await waitFor(() => expect(window.clubhouse.legacyDefaults.describe).toHaveBeenCalled());
      expect(screen.queryByTestId('legacy-defaults-section')).not.toBeInTheDocument();
    });

    it('keeps a plugin item attributed, and removing it reads the values again', async () => {
      window.clubhouse.agentSettings.getProjectConfigBreakdown = vi.fn().mockResolvedValue(breakdown({
        allowRules: [{ id: 'allow-rule:1', label: 'Bash(plugin-cmd)', value: 'Bash(plugin-cmd) /* plugin:foo */', provenance: { source: 'plugin', pluginId: 'foo' } }],
      }));
      renderSection();
      expect(await screen.findByText('Bash(plugin-cmd)')).toBeInTheDocument();
      expect(screen.getByText('foo')).toBeInTheDocument();
      fireEvent.click(screen.getByLabelText('Remove this item'));
      fireEvent.click(await screen.findByText('Remove'));
      await waitFor(() => expect(window.clubhouse.agentSettings.removePluginInjectionItem).toHaveBeenCalledWith('/project', 'allow-rule:1'));
      await waitFor(() => expect(window.clubhouse.legacyDefaults.describe).toHaveBeenCalledTimes(2));
    });

    it('previews an import as parts and imports only when confirmed', async () => {
      window.clubhouse.legacyDefaults.previewImport = vi.fn().mockResolvedValue({
        parts: [{ kind: 'block', name: 'app legacy instructions', status: 'new' }, { kind: 'mcp', name: 'docs', status: 'in_library' }],
        notes: ['Permission rules aren\'t parts: each CLI has its own syntax.'],
      });
      window.clubhouse.legacyDefaults.importAsParts = vi.fn().mockResolvedValue({
        created: [{ id: 'p1', kind: 'block', name: 'app legacy instructions' }], existing: [{ id: 'p2', kind: 'mcp', name: 'docs' }], notes: [],
      });
      renderSection();
      fireEvent.click(await screen.findByTestId('legacy-import-open'));
      const dialog = await screen.findByTestId('legacy-import-dialog');
      expect(await within(dialog).findByText('app legacy instructions')).toBeInTheDocument();
      expect(within(dialog).getByText(/already in your library/)).toBeInTheDocument();
      expect(within(dialog).getByText(/Permission rules aren't parts/)).toBeInTheDocument();
      expect(window.clubhouse.legacyDefaults.importAsParts).not.toHaveBeenCalled();
      fireEvent.click(screen.getByTestId('legacy-import-confirm'));
      expect(await screen.findByText(/Imported app legacy instructions/)).toBeInTheDocument();
      expect(window.clubhouse.legacyDefaults.importAsParts).toHaveBeenCalledWith('/project');
    });

    it('previews a copy into the chosen plain agent and copies only when confirmed', async () => {
      window.clubhouse.legacyDefaults.previewCopy = vi.fn().mockImplementation(async (_p: string, id: string) => (id === 'a2'
        ? { agentName: 'pilot', cli: 'Copilot CLI', blocked: null, changes: [
          { item: 'permissions', target: '.github/settings.local.json', action: 'skip', detail: 'Copilot CLI has no allow and deny rules, so they aren\'t copied.' },
          { item: 'instructions', target: '.github/copilot-instructions.md', action: 'append', detail: 'The project\'s instructions (1 lines) are added to the end.' },
        ] }
        : { agentName: 'scout', cli: 'Claude Code', blocked: null, changes: [{ item: 'instructions', target: 'CLAUDE.md', action: 'unchanged', detail: 'Already in the file.' }] }));
      renderSection();
      fireEvent.click(await screen.findByTestId('legacy-copy-open'));
      const dialog = await screen.findByTestId('legacy-copy-dialog');
      expect(await within(dialog).findByText(/Already in the file/)).toBeInTheDocument();
      expect(screen.getByTestId('legacy-copy-confirm')).toBeDisabled();
      fireEvent.change(within(dialog).getByLabelText('Agent'), { target: { value: 'a2' } });
      expect(await within(dialog).findByText(/no allow and deny rules/)).toBeInTheDocument();
      expect(window.clubhouse.legacyDefaults.copyIntoAgent).not.toHaveBeenCalled();
      fireEvent.click(screen.getByTestId('legacy-copy-confirm'));
      await waitFor(() => expect(window.clubhouse.legacyDefaults.copyIntoAgent).toHaveBeenCalledWith('/project', 'a2'));
    });
  });
});
