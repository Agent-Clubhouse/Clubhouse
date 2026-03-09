import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SourceSkillsSection } from './SourceSkillsSection';

vi.mock('../../components/SettingsMonacoEditor', () => ({
  SettingsMonacoEditor: ({ value, onChange }: any) => (
    <textarea
      data-testid="mock-editor"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));

describe('SourceSkillsSection', () => {
  const projectPath = '/home/user/my-project';

  beforeEach(() => {
    vi.clearAllMocks();
    window.clubhouse.agentSettings.listSourceSkills = vi.fn().mockResolvedValue([
      { name: 'deploy', path: '/home/user/my-project/.clubhouse/skills/deploy' },
      { name: 'test-runner', path: '/home/user/my-project/.clubhouse/skills/test-runner' },
    ]);
    window.clubhouse.agentSettings.readSourceSkillContent = vi.fn().mockResolvedValue('# Deploy\nDeploys to production.');
    window.clubhouse.agentSettings.writeSourceSkillContent = vi.fn().mockResolvedValue(undefined);
    window.clubhouse.agentSettings.deleteSourceSkill = vi.fn().mockResolvedValue(undefined);
    window.clubhouse.file.showInFolder = vi.fn();
  });

  it('renders without crash', async () => {
    render(<SourceSkillsSection projectPath={projectPath} />);
    expect(screen.getByText('Skills')).toBeInTheDocument();
  });

  it('loads and displays skills', async () => {
    render(<SourceSkillsSection projectPath={projectPath} />);
    await waitFor(() => {
      expect(screen.getByText('deploy')).toBeInTheDocument();
      expect(screen.getByText('test-runner')).toBeInTheDocument();
    });
  });

  it('shows empty state when no skills', async () => {
    window.clubhouse.agentSettings.listSourceSkills = vi.fn().mockResolvedValue([]);
    render(<SourceSkillsSection projectPath={projectPath} />);
    await waitFor(() => {
      expect(screen.getByText('No skills defined.')).toBeInTheDocument();
    });
  });

  it('shows create view when + Skill clicked', async () => {
    render(<SourceSkillsSection projectPath={projectPath} />);
    await waitFor(() => screen.getByText('deploy'));
    fireEvent.click(screen.getByText('+ Skill'));
    expect(screen.getByText('New Skill')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('skill-name (lowercase, hyphens)')).toBeInTheDocument();
  });

  it('shows delete confirmation dialog', async () => {
    render(<SourceSkillsSection projectPath={projectPath} />);
    await waitFor(() => screen.getByText('deploy'));
    const deleteButtons = screen.getAllByTitle('Delete skill');
    fireEvent.click(deleteButtons[0]);
    expect(screen.getByText('Delete Skill')).toBeInTheDocument();
  });

  it('cancels delete dialog', async () => {
    render(<SourceSkillsSection projectPath={projectPath} />);
    await waitFor(() => screen.getByText('deploy'));
    const deleteButtons = screen.getAllByTitle('Delete skill');
    fireEvent.click(deleteButtons[0]);
    fireEvent.click(screen.getByText('Cancel'));
    expect(screen.queryByText('Delete Skill')).not.toBeInTheDocument();
  });

  it('cancels create view', async () => {
    render(<SourceSkillsSection projectPath={projectPath} />);
    await waitFor(() => screen.getByText('deploy'));
    fireEvent.click(screen.getByText('+ Skill'));
    fireEvent.click(screen.getByText('Cancel'));
    expect(screen.queryByText('New Skill')).not.toBeInTheDocument();
  });

  it('shows folder path hint', () => {
    render(<SourceSkillsSection projectPath={projectPath} />);
    expect(screen.getByText('.clubhouse/skills/')).toBeInTheDocument();
  });
});
