import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProjectSettings } from './ProjectSettings';
import { useProjectStore } from '../../stores/projectStore';
import { useUIStore } from '../../stores/uiStore';
import type { Project } from '../../../shared/types';

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
const mockPickProjectImage = vi.fn().mockResolvedValue(null);
const mockSaveCroppedProjectIcon = vi.fn().mockResolvedValue(undefined);
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
      const { container } = render(<ProjectSettings />);
      const indigoBtn = screen.getByTitle('Indigo');
      const svg = indigoBtn.querySelector('svg');
      expect(svg).toBeTruthy();
    });

    it('defaults to indigo when no color is set', () => {
      resetStores({ color: undefined });
      const indigoBtn = render(<ProjectSettings />);
      // Indigo should show check when no color set
      const svg = screen.getByTitle('Indigo').querySelector('svg');
      expect(svg).toBeTruthy();
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

    it('clicking Close Project removes project and closes settings', () => {
      resetStores();
      render(<ProjectSettings />);
      fireEvent.click(screen.getByText('Close Project'));

      expect(mockToggleSettings).toHaveBeenCalled();
      expect(mockRemoveProject).toHaveBeenCalledWith('proj-1');
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
});
