import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProjectSettings } from './ProjectSettings';
import { showConfirmDialog } from '../../plugins/PluginDialog';
import { useProjectStore } from '../../stores/projectStore';
import { useUIStore } from '../../stores/uiStore';
import { useAgentStore } from '../../stores/agentStore';
import { useToastStore } from '../../stores/toastStore';
import { pluginCommandRegistry } from '../../plugins/plugin-commands';
import type {
  Project,
  LaunchWrapperConfig,
  McpCatalogEntry,
  WrapperCatalogSnapshot,
} from '../../../shared/types';

vi.mock('../../plugins/PluginDialog', () => ({
  showConfirmDialog: vi.fn(() => ({ promise: Promise.resolve(true), cleanup: vi.fn() })),
}));

vi.mock('./ResetProjectDialog', () => ({
  ResetProjectDialog: ({ projectName, onConfirm, onCancel }: any) => (
    <div data-testid="reset-dialog">
      <span data-testid="reset-project-name">{projectName}</span>
      <button data-testid="reset-confirm" onClick={onConfirm}>Confirm Reset</button>
      <button data-testid="reset-cancel" onClick={onCancel}>Cancel Reset</button>
    </div>
  ),
}));

vi.mock('../../components/ImageCropDialog', () => ({
  ImageCropDialog: ({ onConfirm, onCancel }: any) => (
    <div data-testid="image-crop-dialog">
      <button data-testid="crop-confirm" onClick={() => onConfirm('cropped-data-url')}>Confirm Crop</button>
      <button data-testid="crop-cancel" onClick={onCancel}>Cancel Crop</button>
    </div>
  ),
}));

const baseProject: Project = {
  id: 'proj-1',
  name: 'my-project',
  path: '/home/user/my-project',
  color: 'indigo',
};

const mockUpdateProject = vi.fn();
const mockRemoveProject = vi.fn();
const mockPickProjectImage = vi.fn();
const mockSaveCroppedProjectIcon = vi.fn();
const mockToggleSettings = vi.fn();

function resetStores(projectOverrides: Partial<Project> = {}) {
  const project = { ...baseProject, ...projectOverrides };
  useProjectStore.setState({
    projects: [project],
    activeProjectId: project.id,
    projectIcons: {},
    updateProject: mockUpdateProject,
    removeProject: mockRemoveProject,
    pickProjectImage: mockPickProjectImage,
    saveCroppedProjectIcon: mockSaveCroppedProjectIcon,
  });
  useUIStore.setState({
    toggleSettings: mockToggleSettings,
  });
}

describe('ProjectSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPickProjectImage.mockResolvedValue(null);
    mockSaveCroppedProjectIcon.mockResolvedValue(undefined);
    window.clubhouse.project.resetProject = vi.fn().mockResolvedValue(undefined);
  });

  describe('no project selected', () => {
    it('shows fallback message when no project found', () => {
      useProjectStore.setState({ projects: [], activeProjectId: null });
      render(<ProjectSettings />);
      expect(screen.getByText('Select a project')).toBeInTheDocument();
    });

    it('shows fallback when projectId does not match', () => {
      resetStores();
      render(<ProjectSettings projectId="nonexistent" />);
      expect(screen.getByText('Select a project')).toBeInTheDocument();
    });

    it('does not crash when project is removed mid-lifecycle (hooks ordering)', () => {
      // Verifies that useState/useEffect run before the conditional return,
      // so removing the project doesn't violate Rules of Hooks.
      resetStores();
      const { rerender } = render(<ProjectSettings />);
      expect(screen.getByText('Project Settings')).toBeInTheDocument();

      // Remove the project from the store
      useProjectStore.setState({ projects: [], activeProjectId: null });
      // Re-render — must not throw due to hooks ordering
      rerender(<ProjectSettings />);
      expect(screen.getByText('Select a project')).toBeInTheDocument();
    });
  });

  describe('rendering', () => {
    it('renders Project Settings heading', () => {
      resetStores();
      render(<ProjectSettings />);
      expect(screen.getByText('Project Settings')).toBeInTheDocument();
    });

    it('renders the project path', () => {
      resetStores();
      render(<ProjectSettings />);
      expect(screen.getByText('/home/user/my-project')).toBeInTheDocument();
    });

    it('renders color picker with all colors', () => {
      resetStores();
      render(<ProjectSettings />);

      expect(screen.getByTitle('Indigo')).toBeInTheDocument();
      expect(screen.getByTitle('Emerald')).toBeInTheDocument();
      expect(screen.getByTitle('Amber')).toBeInTheDocument();
      expect(screen.getByTitle('Rose')).toBeInTheDocument();
      expect(screen.getByTitle('Cyan')).toBeInTheDocument();
      expect(screen.getByTitle('Violet')).toBeInTheDocument();
      expect(screen.getByTitle('Orange')).toBeInTheDocument();
      expect(screen.getByTitle('Teal')).toBeInTheDocument();
    });

    it('uses activeProjectId when projectId prop is not provided', () => {
      resetStores();
      render(<ProjectSettings />);
      // The project path should be rendered, confirming the correct project was found
      expect(screen.getByText('/home/user/my-project')).toBeInTheDocument();
    });

    it('uses provided projectId over activeProjectId', () => {
      const secondProject: Project = { id: 'proj-2', name: 'other-project', path: '/other' };
      useProjectStore.setState({
        projects: [baseProject, secondProject],
        activeProjectId: 'proj-1',
        projectIcons: {},
        updateProject: mockUpdateProject,
        removeProject: mockRemoveProject,
        pickProjectImage: mockPickProjectImage,
        saveCroppedProjectIcon: mockSaveCroppedProjectIcon,
      });
      useUIStore.setState({ toggleSettings: mockToggleSettings });

      render(<ProjectSettings projectId="proj-2" />);
      expect(screen.getByText('/other')).toBeInTheDocument();
    });
  });

  describe('name editing', () => {
    it('renders name input with current name', () => {
      resetStores();
      render(<ProjectSettings />);
      const input = screen.getByPlaceholderText('my-project') as HTMLInputElement;
      expect(input.value).toBe('my-project');
    });

    it('shows Save button when name is changed', () => {
      resetStores();
      render(<ProjectSettings />);
      const input = screen.getByPlaceholderText('my-project');
      fireEvent.change(input, { target: { value: 'new-name' } });
      expect(screen.getByText('Save')).toBeInTheDocument();
    });

    it('does not show Save button when name matches', () => {
      resetStores();
      render(<ProjectSettings />);
      expect(screen.queryByText('Save')).toBeNull();
    });

    it('calls updateProject when Save is clicked', () => {
      resetStores();
      render(<ProjectSettings />);
      const input = screen.getByPlaceholderText('my-project');
      fireEvent.change(input, { target: { value: 'new-name' } });
      fireEvent.click(screen.getByText('Save'));

      expect(mockUpdateProject).toHaveBeenCalledWith('proj-1', { displayName: 'new-name' });
    });

    it('clears displayName when name matches original', () => {
      resetStores({ displayName: 'custom-name' });
      render(<ProjectSettings />);
      const input = screen.getByDisplayValue('custom-name');
      fireEvent.change(input, { target: { value: 'my-project' } });
      fireEvent.click(screen.getByText('Save'));

      expect(mockUpdateProject).toHaveBeenCalledWith('proj-1', { displayName: '' });
    });

    it('saves on Enter key', () => {
      resetStores();
      render(<ProjectSettings />);
      const input = screen.getByPlaceholderText('my-project');
      fireEvent.change(input, { target: { value: 'enter-name' } });
      fireEvent.keyDown(input, { key: 'Enter' });

      expect(mockUpdateProject).toHaveBeenCalledWith('proj-1', { displayName: 'enter-name' });
    });

    it('clears displayName for blank input', () => {
      resetStores();
      render(<ProjectSettings />);
      const input = screen.getByPlaceholderText('my-project');
      fireEvent.change(input, { target: { value: '   ' } });
      fireEvent.click(screen.getByText('Save'));

      expect(mockUpdateProject).toHaveBeenCalledWith('proj-1', { displayName: '' });
    });
  });

  describe('color picker', () => {
    it('clicking a color calls updateProject', () => {
      resetStores();
      render(<ProjectSettings />);
      fireEvent.click(screen.getByTitle('Emerald'));
      expect(mockUpdateProject).toHaveBeenCalledWith('proj-1', { color: 'emerald' });
    });

    it('shows check mark on selected color', () => {
      resetStores({ color: 'indigo' });
      render(<ProjectSettings />);
      const indigoBtn = screen.getByTitle('Indigo');
      const svg = indigoBtn.querySelector('svg');
      expect(svg).toBeInTheDocument();
    });

    it('defaults to indigo when no color is set', () => {
      resetStores({ color: undefined });
      const _indigoBtn = render(<ProjectSettings />);
      // Indigo should show check when no color set
      const svg = screen.getByTitle('Indigo').querySelector('svg');
      expect(svg).toBeInTheDocument();
    });
  });

  describe('icon management', () => {
    it('renders Choose Image button', () => {
      resetStores();
      render(<ProjectSettings />);
      expect(screen.getByText('Choose Image')).toBeInTheDocument();
    });

    it('opens image crop dialog when image is picked', async () => {
      mockPickProjectImage.mockResolvedValue('data:image/png;base64,abc');
      resetStores();
      render(<ProjectSettings />);

      fireEvent.click(screen.getByText('Choose Image'));

      expect(await screen.findByTestId('image-crop-dialog')).toBeInTheDocument();
    });

    it('does not open crop dialog when no image selected', async () => {
      mockPickProjectImage.mockResolvedValue(null);
      resetStores();
      render(<ProjectSettings />);

      fireEvent.click(screen.getByText('Choose Image'));

      await waitFor(() => {
        expect(screen.queryByTestId('image-crop-dialog')).toBeNull();
      });
    });

    it('saves cropped icon on confirm', async () => {
      mockPickProjectImage.mockResolvedValue('data:image/png;base64,abc');
      resetStores();
      render(<ProjectSettings />);

      fireEvent.click(screen.getByText('Choose Image'));
      const confirmBtn = await screen.findByTestId('crop-confirm');
      fireEvent.click(confirmBtn);

      await waitFor(() => {
        expect(mockSaveCroppedProjectIcon).toHaveBeenCalledWith('proj-1', 'cropped-data-url');
      });
    });

    it('shows Remove button when icon exists', () => {
      resetStores({ icon: 'icon.png' });
      useProjectStore.setState({
        projectIcons: { 'proj-1': 'data:image/png;base64,xyz' },
      });
      render(<ProjectSettings />);
      expect(screen.getByText('Remove')).toBeInTheDocument();
    });

    it('clicking Remove clears the icon', () => {
      resetStores({ icon: 'icon.png' });
      useProjectStore.setState({
        projectIcons: { 'proj-1': 'data:image/png;base64,xyz' },
      });
      render(<ProjectSettings />);
      fireEvent.click(screen.getByText('Remove'));
      expect(mockUpdateProject).toHaveBeenCalledWith('proj-1', { icon: '' });
    });

    it('shows initial letter when no icon exists', () => {
      resetStores();
      render(<ProjectSettings />);
      expect(screen.getByText('M')).toBeInTheDocument();
    });
  });

  describe('danger zone', () => {
    it('renders Close Project and Reset Project buttons', () => {
      resetStores();
      render(<ProjectSettings />);
      expect(screen.getByText('Close Project')).toBeInTheDocument();
      expect(screen.getByText('Reset Project')).toBeInTheDocument();
    });

    it('clicking Close Project removes project and closes settings', async () => {
      resetStores();
      render(<ProjectSettings />);
      fireEvent.click(screen.getByText('Close Project'));

      await waitFor(() => {
        expect(showConfirmDialog).toHaveBeenCalled();
        expect(mockToggleSettings).toHaveBeenCalled();
        expect(mockRemoveProject).toHaveBeenCalledWith('proj-1');
      });
    });

    it('clicking Reset Project shows confirmation dialog', () => {
      resetStores();
      render(<ProjectSettings />);
      fireEvent.click(screen.getByText('Reset Project'));
      expect(screen.getByTestId('reset-dialog')).toBeInTheDocument();
    });

    it('confirming reset calls resetProject API', async () => {
      resetStores();
      render(<ProjectSettings />);
      fireEvent.click(screen.getByText('Reset Project'));
      fireEvent.click(screen.getByTestId('reset-confirm'));

      await waitFor(() => {
        expect(window.clubhouse.project.resetProject).toHaveBeenCalledWith('/home/user/my-project');
      });
      expect(mockToggleSettings).toHaveBeenCalled();
      expect(mockRemoveProject).toHaveBeenCalledWith('proj-1');
    });

    it('canceling reset closes dialog', () => {
      resetStores();
      render(<ProjectSettings />);
      fireEvent.click(screen.getByText('Reset Project'));
      expect(screen.getByTestId('reset-dialog')).toBeInTheDocument();

      fireEvent.click(screen.getByTestId('reset-cancel'));
      expect(screen.queryByTestId('reset-dialog')).toBeNull();
    });

    it('shows danger zone description', () => {
      resetStores();
      render(<ProjectSettings />);
      expect(screen.getByText(/Close removes the project from Clubhouse/)).toBeInTheDocument();
    });
  });

  describe('LaunchWrapperSection', () => {
    const wrapperWithRefresh: LaunchWrapperConfig = {
      binary: 'mywrapper',
      separator: '--',
      orchestratorMap: { 'claude-code': { subcommand: 'claude' } },
      refreshCommandId: 'mywrapper.refresh',
      contributingPluginId: 'mywrapper',
    };

    const wrapperNoRefresh: LaunchWrapperConfig = {
      binary: 'mywrapper',
      separator: '--',
      orchestratorMap: { 'claude-code': { subcommand: 'claude' } },
    };

    function setupWrapperState(opts: {
      wrapper?: LaunchWrapperConfig;
      catalog?: McpCatalogEntry[];
      defaultMcps?: string[];
      snapshot?: WrapperCatalogSnapshot;
      agentMcpIds?: string[];
    }) {
      const reads = {
        readLaunchWrapper: vi.fn().mockResolvedValue(opts.wrapper),
        readMcpCatalog: vi.fn().mockResolvedValue(opts.catalog ?? []),
        readDefaultMcps: vi.fn().mockResolvedValue(opts.defaultMcps ?? []),
        readWrapperCatalogSnapshot: vi.fn().mockResolvedValue(opts.snapshot),
      };
      window.clubhouse.project.readLaunchWrapper = reads.readLaunchWrapper;
      window.clubhouse.project.readMcpCatalog = reads.readMcpCatalog;
      window.clubhouse.project.readDefaultMcps = reads.readDefaultMcps;
      window.clubhouse.project.readWrapperCatalogSnapshot = reads.readWrapperCatalogSnapshot;
      window.clubhouse.project.writeLaunchWrapper = vi.fn().mockResolvedValue(undefined);
      window.clubhouse.project.writeMcpCatalog = vi.fn().mockResolvedValue(undefined);
      window.clubhouse.project.writeDefaultMcps = vi.fn().mockResolvedValue(undefined);
      window.clubhouse.project.writeWrapperCatalogSnapshot = vi.fn().mockResolvedValue(undefined);

      // Seed a single durable agent that contributes mcpIds (when provided).
      const agents: Record<string, any> = {};
      if (opts.agentMcpIds) {
        agents['agent-1'] = {
          id: 'agent-1',
          projectId: 'proj-1',
          name: 'a1',
          kind: 'durable',
          status: 'idle',
          color: 'indigo',
          mcpIds: opts.agentMcpIds,
        };
      }
      useAgentStore.setState({ agents });
      useToastStore.setState({ toasts: [] });

      return reads;
    }

    beforeEach(() => {
      pluginCommandRegistry.clear();
    });

    it('renders no-wrapper message when no wrapper is configured', async () => {
      setupWrapperState({});
      resetStores();
      render(<ProjectSettings />);
      expect(
        await screen.findByText(/No launch wrapper configured/i),
      ).toBeInTheDocument();
    });

    it('renders binary name and Default MCPs when wrapper is configured', async () => {
      setupWrapperState({
        wrapper: wrapperNoRefresh,
        catalog: [
          { id: 'fs', name: 'Filesystem', description: 'Filesystem MCP' },
        ],
        defaultMcps: ['fs'],
        // Snapshot equals catalog so no diff.
        snapshot: {
          lastSeenCatalog: [
            { id: 'fs', name: 'Filesystem', description: 'Filesystem MCP' },
          ],
          lastSeenAt: '2026-05-07T00:00:00Z',
        },
      });
      resetStores();
      render(<ProjectSettings />);
      expect(await screen.findByText('mywrapper')).toBeInTheDocument();
      expect(await screen.findByText('Default MCPs')).toBeInTheDocument();
      expect(screen.getByText('Filesystem')).toBeInTheDocument();
      expect(screen.queryByText('Refresh')).toBeNull();
    });

    it('does not render Refresh button when refreshCommandId is unset', async () => {
      setupWrapperState({
        wrapper: wrapperNoRefresh,
        catalog: [{ id: 'a', name: 'A', description: 'A' }],
      });
      resetStores();
      render(<ProjectSettings />);
      await screen.findByText('mywrapper');
      expect(screen.queryByText(/Refresh/)).toBeNull();
    });

    it('renders Refresh button when refreshCommandId is set', async () => {
      setupWrapperState({
        wrapper: wrapperWithRefresh,
        catalog: [{ id: 'a', name: 'A', description: 'A' }],
        snapshot: {
          lastSeenCatalog: [{ id: 'a', name: 'A', description: 'A' }],
          lastSeenAt: '2026-05-07T00:00:00Z',
        },
      });
      resetStores();
      render(<ProjectSettings />);
      expect(await screen.findByTitle('Refresh catalog')).toBeInTheDocument();
    });

    it('shows NEW badge on entries that are not in snapshot', async () => {
      setupWrapperState({
        wrapper: wrapperWithRefresh,
        catalog: [
          { id: 'fs', name: 'Filesystem', description: 'old' },
          { id: 'newone', name: 'New One', description: 'new' },
        ],
        defaultMcps: ['fs'],
        snapshot: {
          lastSeenCatalog: [
            { id: 'fs', name: 'Filesystem', description: 'old' },
          ],
          lastSeenAt: '2026-05-07T00:00:00Z',
        },
      });
      resetStores();
      render(<ProjectSettings />);
      await screen.findByText('New One');
      // NEW badge text appears
      expect(screen.getByText('new')).toBeInTheDocument();
    });

    it('renders diff banner with correct count text when entries differ', async () => {
      setupWrapperState({
        wrapper: wrapperWithRefresh,
        catalog: [
          { id: 'a', name: 'A', description: 'A-new-desc' },
          { id: 'b', name: 'B', description: 'B' },
        ],
        defaultMcps: ['a'],
        snapshot: {
          lastSeenCatalog: [
            { id: 'a', name: 'A', description: 'A-old-desc' },
          ],
          lastSeenAt: '2026-05-07T00:00:00Z',
        },
      });
      resetStores();
      render(<ProjectSettings />);
      // 1 changed (a) + 1 new (b)
      expect(await screen.findByText('1 new · 1 changed')).toBeInTheDocument();
      expect(screen.getByText('Got it')).toBeInTheDocument();
    });

    it('shows REMOVED entry only when in selection', async () => {
      setupWrapperState({
        wrapper: wrapperWithRefresh,
        catalog: [{ id: 'kept', name: 'Kept', description: 'k' }],
        defaultMcps: ['gone'],
        snapshot: {
          lastSeenCatalog: [
            { id: 'kept', name: 'Kept', description: 'k' },
            { id: 'gone', name: 'Gone', description: 'g' },
          ],
          lastSeenAt: '2026-05-07T00:00:00Z',
        },
      });
      resetStores();
      render(<ProjectSettings />);
      await screen.findByText('Kept');
      expect(screen.getByText('Gone')).toBeInTheDocument();
      expect(screen.getByText('removed')).toBeInTheDocument();
    });

    it('hides banner when no diff exists', async () => {
      const catalog = [{ id: 'a', name: 'A', description: 'a' }];
      setupWrapperState({
        wrapper: wrapperWithRefresh,
        catalog,
        defaultMcps: ['a'],
        snapshot: { lastSeenCatalog: catalog, lastSeenAt: '2026-05-07T00:00:00Z' },
      });
      resetStores();
      render(<ProjectSettings />);
      await screen.findByText('A');
      expect(screen.queryByText('Got it')).toBeNull();
    });

    it('clicking Got it writes snapshot and reloads', async () => {
      const catalog = [{ id: 'a', name: 'A', description: 'a' }];
      setupWrapperState({
        wrapper: wrapperWithRefresh,
        catalog,
        defaultMcps: ['a'],
        snapshot: undefined, // no snapshot — everything is "new"
      });
      resetStores();
      render(<ProjectSettings />);
      const button = await screen.findByText('Got it');
      fireEvent.click(button);
      await waitFor(() => {
        expect(window.clubhouse.project.writeWrapperCatalogSnapshot).toHaveBeenCalledWith(
          '/home/user/my-project',
          expect.objectContaining({ lastSeenCatalog: catalog }),
        );
      });
    });

    it('Refresh invokes the registered command and reloads', async () => {
      const reads = setupWrapperState({
        wrapper: wrapperWithRefresh,
        catalog: [{ id: 'a', name: 'A', description: 'a' }],
        snapshot: {
          lastSeenCatalog: [{ id: 'a', name: 'A', description: 'a' }],
          lastSeenAt: '2026-05-07T00:00:00Z',
        },
      });
      const handler = vi.fn().mockResolvedValue(undefined);
      pluginCommandRegistry.register('mywrapper.refresh', handler);

      resetStores();
      render(<ProjectSettings />);
      const refreshBtn = await screen.findByTitle('Refresh catalog');
      await act(async () => {
        fireEvent.click(refreshBtn);
      });
      expect(handler).toHaveBeenCalled();
      // load() called once on mount, then again after refresh.
      await waitFor(() => {
        expect(reads.readLaunchWrapper.mock.calls.length).toBeGreaterThanOrEqual(2);
      });
    });

    it('Refresh resolves prefixed command id when raw id misses', async () => {
      // Real plugins register commands as `${pluginId}:${commandId}` (see plugin-api-ui.ts),
      // so the renderer must fall back to the prefixed form when the raw id isn't found.
      const reads = setupWrapperState({
        wrapper: wrapperWithRefresh,
        catalog: [{ id: 'a', name: 'A', description: 'a' }],
        snapshot: {
          lastSeenCatalog: [{ id: 'a', name: 'A', description: 'a' }],
          lastSeenAt: '2026-05-07T00:00:00Z',
        },
      });
      const handler = vi.fn().mockResolvedValue(undefined);
      // Register ONLY under the prefixed name — the raw id 'mywrapper.refresh'
      // must not resolve directly.
      pluginCommandRegistry.register('mywrapper:mywrapper.refresh', handler);

      resetStores();
      render(<ProjectSettings />);
      const refreshBtn = await screen.findByTitle('Refresh catalog');
      await act(async () => {
        fireEvent.click(refreshBtn);
      });
      expect(handler).toHaveBeenCalled();
      // load() called once on mount, then again after refresh — confirms the
      // fallback path completed successfully and triggered a catalog re-read.
      await waitFor(() => {
        expect(reads.readLaunchWrapper.mock.calls.length).toBeGreaterThanOrEqual(2);
      });
    });

    it('Refresh shows toast on failure', async () => {
      setupWrapperState({
        wrapper: wrapperWithRefresh,
        catalog: [{ id: 'a', name: 'A', description: 'a' }],
        snapshot: {
          lastSeenCatalog: [{ id: 'a', name: 'A', description: 'a' }],
          lastSeenAt: '2026-05-07T00:00:00Z',
        },
      });
      const handler = vi.fn().mockRejectedValue(new Error('boom'));
      pluginCommandRegistry.register('mywrapper.refresh', handler);

      resetStores();
      render(<ProjectSettings />);
      const refreshBtn = await screen.findByTitle('Refresh catalog');
      await act(async () => {
        fireEvent.click(refreshBtn);
      });
      await waitFor(() => {
        const toasts = useToastStore.getState().toasts;
        expect(toasts.some((t) => t.message.includes('boom') && t.type === 'error')).toBe(true);
      });
    });

    it('Refresh fails gracefully when command not registered', async () => {
      setupWrapperState({
        wrapper: wrapperWithRefresh,
        catalog: [],
      });

      resetStores();
      render(<ProjectSettings />);
      const refreshBtn = await screen.findByTitle('Refresh catalog');
      await act(async () => {
        fireEvent.click(refreshBtn);
      });
      await waitFor(() => {
        const toasts = useToastStore.getState().toasts;
        expect(toasts.some((t) => /not registered/i.test(t.message))).toBe(true);
      });
    });

    it('clicking Remove Wrapper button shows confirm dialog without firing delete', async () => {
      setupWrapperState({
        wrapper: wrapperNoRefresh,
        catalog: [],
      });
      resetStores();
      render(<ProjectSettings />);
      const removeBtn = await screen.findByTestId('remove-wrapper-button');
      fireEvent.click(removeBtn);
      expect(screen.getByText('Remove Launch Wrapper?')).toBeInTheDocument();
      expect(window.clubhouse.project.writeLaunchWrapper).not.toHaveBeenCalled();
    });

    it('cancelling the confirm dialog does not remove wrapper', async () => {
      setupWrapperState({
        wrapper: wrapperNoRefresh,
        catalog: [],
      });
      resetStores();
      render(<ProjectSettings />);
      const removeBtn = await screen.findByTestId('remove-wrapper-button');
      fireEvent.click(removeBtn);
      fireEvent.click(screen.getByTestId('confirm-destructive-cancel'));
      expect(window.clubhouse.project.writeLaunchWrapper).not.toHaveBeenCalled();
    });

    it('confirming remove dialog clears wrapper, catalog, defaults, and snapshot', async () => {
      setupWrapperState({
        wrapper: wrapperNoRefresh,
        catalog: [{ id: 'a', name: 'A', description: 'a' }],
        defaultMcps: ['a'],
      });
      resetStores();
      render(<ProjectSettings />);
      const removeBtn = await screen.findByTestId('remove-wrapper-button');
      fireEvent.click(removeBtn);
      await act(async () => {
        fireEvent.click(screen.getByTestId('confirm-destructive-confirm'));
      });
      await waitFor(() => {
        expect(window.clubhouse.project.writeLaunchWrapper).toHaveBeenCalledWith(
          '/home/user/my-project',
          undefined,
        );
        expect(window.clubhouse.project.writeMcpCatalog).toHaveBeenCalledWith(
          '/home/user/my-project',
          [],
        );
        expect(window.clubhouse.project.writeDefaultMcps).toHaveBeenCalledWith(
          '/home/user/my-project',
          [],
        );
        expect(window.clubhouse.project.writeWrapperCatalogSnapshot).toHaveBeenCalledWith(
          '/home/user/my-project',
          undefined,
        );
      });
    });
  });
});
