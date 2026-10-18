import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SourceAgentTemplatesSection } from './SourceAgentTemplatesSection';

vi.mock('../../components/SettingsMonacoEditor', () => ({
  SettingsMonacoEditor: ({ value, onChange }: any) => (
    <textarea
      data-testid="mock-editor"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));

describe('SourceAgentTemplatesSection', () => {
  const projectPath = '/home/user/my-project';

  beforeEach(() => {
    vi.clearAllMocks();
    window.clubhouse.agentSettings.listSourceAgentTemplates = vi.fn().mockResolvedValue([
      { name: 'reviewer', path: '/home/user/my-project/.clubhouse/agent-templates/reviewer' },
      { name: 'coder', path: '/home/user/my-project/.clubhouse/agent-templates/coder' },
    ]);
    window.clubhouse.agentSettings.readSourceAgentTemplateContent = vi.fn().mockResolvedValue('# Reviewer\nReviews PRs.');
    window.clubhouse.agentSettings.writeSourceAgentTemplateContent = vi.fn().mockResolvedValue(undefined);
    window.clubhouse.agentSettings.deleteSourceAgentTemplate = vi.fn().mockResolvedValue(undefined);
    window.clubhouse.file.showInFolder = vi.fn();
  });

  it('renders without crash', async () => {
    render(<SourceAgentTemplatesSection projectPath={projectPath} />);
    expect(screen.getByText('Agent definitions')).toBeInTheDocument();
  });

  it('loads and displays templates', async () => {
    render(<SourceAgentTemplatesSection projectPath={projectPath} />);
    await waitFor(() => {
      expect(screen.getByText('reviewer')).toBeInTheDocument();
      expect(screen.getByText('coder')).toBeInTheDocument();
    });
  });

  it('shows empty state when no templates', async () => {
    window.clubhouse.agentSettings.listSourceAgentTemplates = vi.fn().mockResolvedValue([]);
    render(<SourceAgentTemplatesSection projectPath={projectPath} />);
    await waitFor(() => {
      expect(screen.getByText('No agent definitions found.')).toBeInTheDocument();
    });
  });

  it('shows create view when New definition clicked', async () => {
    render(<SourceAgentTemplatesSection projectPath={projectPath} />);
    await waitFor(() => screen.getByText('reviewer'));
    fireEvent.click(screen.getByText('New definition'));
    expect(screen.getByText('New agent definition')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('agent-name (lowercase, hyphens)')).toBeInTheDocument();
  });

  it('shows edit view when template name clicked', async () => {
    render(<SourceAgentTemplatesSection projectPath={projectPath} />);
    await waitFor(() => screen.getByText('reviewer'));
    fireEvent.click(screen.getByText('reviewer'));
    await waitFor(() => {
      expect(screen.getByText('Edit reviewer')).toBeInTheDocument();
    });
  });

  it('shows delete confirmation dialog', async () => {
    render(<SourceAgentTemplatesSection projectPath={projectPath} />);
    await waitFor(() => screen.getByText('reviewer'));
    // Click the delete button (trash icon) - find by title
    const deleteButtons = screen.getAllByTitle('Delete agent definition');
    fireEvent.click(deleteButtons[0]);
    expect(screen.getByText('Delete agent definition?')).toBeInTheDocument();
  });

  it('cancels delete dialog', async () => {
    render(<SourceAgentTemplatesSection projectPath={projectPath} />);
    await waitFor(() => screen.getByText('reviewer'));
    const deleteButtons = screen.getAllByTitle('Delete agent definition');
    fireEvent.click(deleteButtons[0]);
    fireEvent.click(screen.getByText('Cancel'));
    expect(screen.queryByText('Delete agent definition?')).not.toBeInTheDocument();
  });

  it('cancels create view', async () => {
    render(<SourceAgentTemplatesSection projectPath={projectPath} />);
    await waitFor(() => screen.getByText('reviewer'));
    fireEvent.click(screen.getByText('New definition'));
    fireEvent.click(screen.getByText('Cancel'));
    expect(screen.queryByText('New agent definition')).not.toBeInTheDocument();
  });

  it('shows folder path hint', () => {
    render(<SourceAgentTemplatesSection projectPath={projectPath} />);
    expect(screen.getByText('.clubhouse/agent-templates/')).toBeInTheDocument();
  });
});
