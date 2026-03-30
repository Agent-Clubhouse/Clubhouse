import { render, screen, fireEvent } from '@testing-library/react';
import { AgentGalleryDialog } from './AgentGalleryDialog';

vi.mock('../../../shared/name-generator', () => ({
  AGENT_COLORS: [
    { id: 'indigo', hex: '#6366f1', label: 'Indigo' },
    { id: 'red', hex: '#ef4444', label: 'Red' },
    { id: 'emerald', hex: '#10b981', label: 'Emerald' },
    { id: 'pink', hex: '#ec4899', label: 'Pink' },
    { id: 'amber', hex: '#f59e0b', label: 'Amber' },
    { id: 'blue', hex: '#3b82f6', label: 'Blue' },
    { id: 'cyan', hex: '#06b6d4', label: 'Cyan' },
  ],
}));

describe('AgentGalleryDialog', () => {
  const defaultProps = {
    onClose: vi.fn(),
    onCreate: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders all persona templates', () => {
    render(<AgentGalleryDialog {...defaultProps} />);
    expect(screen.getByText('Project Manager')).toBeTruthy();
    expect(screen.getByText('Quality Assurance')).toBeTruthy();
    expect(screen.getByText('UI/Design Lead')).toBeTruthy();
    expect(screen.getByText('Quality Auditor')).toBeTruthy();
    expect(screen.getByText('Executor (PR Only)')).toBeTruthy();
    expect(screen.getByText('Executor (Full Merge)')).toBeTruthy();
    expect(screen.getByText('Documentation Updater')).toBeTruthy();
  });

  it('renders dialog title', () => {
    render(<AgentGalleryDialog {...defaultProps} />);
    expect(screen.getByText('Create Agent from Template')).toBeTruthy();
  });

  it('Create Agent button is disabled when no persona selected', () => {
    render(<AgentGalleryDialog {...defaultProps} />);
    const createBtn = screen.getByText('Create Agent');
    expect(createBtn).toBeDisabled();
  });

  it('Create Agent button is enabled after selecting a persona', () => {
    render(<AgentGalleryDialog {...defaultProps} />);
    fireEvent.click(screen.getByText('Project Manager'));
    const createBtn = screen.getByText('Create Agent');
    expect(createBtn).not.toBeDisabled();
  });

  it('calls onCreate with selected persona and color', () => {
    render(<AgentGalleryDialog {...defaultProps} />);
    fireEvent.click(screen.getByText('Quality Assurance'));
    fireEvent.click(screen.getByText('Create Agent'));
    expect(defaultProps.onCreate).toHaveBeenCalledTimes(1);
    const [persona, color] = defaultProps.onCreate.mock.calls[0];
    expect(persona.id).toBe('qa');
    expect(persona.name).toBe('Quality Assurance');
    expect(typeof color).toBe('string');
  });

  it('calls onClose when Cancel is clicked', () => {
    render(<AgentGalleryDialog {...defaultProps} />);
    fireEvent.click(screen.getByText('Cancel'));
    expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when backdrop is clicked', () => {
    render(<AgentGalleryDialog {...defaultProps} />);
    // Click the backdrop (first child div with bg-black/60)
    const backdrop = document.querySelector('.bg-black\\/60');
    if (backdrop) fireEvent.click(backdrop);
    expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
  });

  it('shows persona descriptions', () => {
    render(<AgentGalleryDialog {...defaultProps} />);
    expect(screen.getByText(/Delegator and planner/)).toBeTruthy();
    expect(screen.getByText(/Skeptical reviewer/)).toBeTruthy();
  });
});
