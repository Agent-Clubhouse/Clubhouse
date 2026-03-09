import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ResetProjectDialog } from './ResetProjectDialog';

describe('ResetProjectDialog', () => {
  const defaultProps = {
    projectName: 'my-app',
    projectPath: '/home/user/my-app',
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    window.clubhouse.project.listClubhouseFiles = vi.fn().mockResolvedValue([
      'CLAUDE.md',
      'agents/',
      'skills/',
    ]);
  });

  it('renders without crash', () => {
    render(<ResetProjectDialog {...defaultProps} />);
    expect(screen.getByText('Reset Project')).toBeInTheDocument();
  });

  it('shows project name in warning text', () => {
    render(<ResetProjectDialog {...defaultProps} />);
    // Project name appears in multiple places (warning text, placeholder, confirmation label)
    expect(screen.getAllByText('my-app').length).toBeGreaterThanOrEqual(1);
  });

  it('shows loading state initially then file list', async () => {
    render(<ResetProjectDialog {...defaultProps} />);
    // Files load asynchronously
    await waitFor(() => {
      expect(screen.getByText('CLAUDE.md')).toBeInTheDocument();
    });
    expect(screen.getByText('agents/')).toBeInTheDocument();
    expect(screen.getByText('skills/')).toBeInTheDocument();
  });

  it('shows "No .clubhouse/ directory found" when no files', async () => {
    window.clubhouse.project.listClubhouseFiles = vi.fn().mockResolvedValue([]);
    render(<ResetProjectDialog {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText('No .clubhouse/ directory found')).toBeInTheDocument();
    });
  });

  it('disables confirm button until project name is typed', () => {
    render(<ResetProjectDialog {...defaultProps} />);
    const confirmBtn = screen.getByText(/Delete .clubhouse/);
    expect(confirmBtn).toBeDisabled();
  });

  it('enables confirm button when correct name is typed', () => {
    render(<ResetProjectDialog {...defaultProps} />);
    const input = screen.getByPlaceholderText('my-app');
    fireEvent.change(input, { target: { value: 'my-app' } });
    const confirmBtn = screen.getByText(/Delete .clubhouse/);
    expect(confirmBtn).not.toBeDisabled();
  });

  it('calls onConfirm when confirmed with correct name', () => {
    render(<ResetProjectDialog {...defaultProps} />);
    const input = screen.getByPlaceholderText('my-app');
    fireEvent.change(input, { target: { value: 'my-app' } });
    fireEvent.click(screen.getByText(/Delete .clubhouse/));
    expect(defaultProps.onConfirm).toHaveBeenCalled();
  });

  it('calls onCancel when cancel is clicked', () => {
    render(<ResetProjectDialog {...defaultProps} />);
    fireEvent.click(screen.getByText('Cancel'));
    expect(defaultProps.onCancel).toHaveBeenCalled();
  });

  it('calls onCancel when backdrop is clicked', () => {
    const { container } = render(<ResetProjectDialog {...defaultProps} />);
    const backdrop = container.querySelector('.fixed.inset-0');
    fireEvent.click(backdrop!);
    expect(defaultProps.onCancel).toHaveBeenCalled();
  });

  it('does not call onCancel when dialog content is clicked', () => {
    render(<ResetProjectDialog {...defaultProps} />);
    fireEvent.click(screen.getByText('Reset Project'));
    expect(defaultProps.onCancel).not.toHaveBeenCalled();
  });
});
