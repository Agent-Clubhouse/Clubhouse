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
  });

  describe('collapsed state', () => {
    it('renders the Default Agent Settings header', async () => {
      renderSection();
      expect(await screen.findByText('Default Agent Settings')).toBeInTheDocument();
    });

    it('does not show form fields when collapsed', async () => {
      renderSection();
      await screen.findByText('Default Agent Settings');
      expect(screen.queryByText('Default Instructions')).not.toBeInTheDocument();
    });

    it('does not show Save button when collapsed', async () => {
      renderSection();
      await screen.findByText('Default Agent Settings');
      expect(screen.queryByText('Save Defaults')).not.toBeInTheDocument();
    });
  });

  describe('expanded state', () => {
    it('shows form fields when expanded', async () => {
      renderSection();
      fireEvent.click(await screen.findByText('Default Agent Settings'));
      expect(await screen.findByText('Default Instructions')).toBeInTheDocument();
      expect(screen.getByText('Default Permissions')).toBeInTheDocument();
      expect(screen.getByText('Default .mcp.json')).toBeInTheDocument();
      expect(screen.getByText('Free Agent Mode by default')).toBeInTheDocument();
    });

    it('loads and displays existing defaults', async () => {
      renderSection();
      fireEvent.click(await screen.findByText('Default Agent Settings'));
      await waitFor(() => {
        expect(screen.getByDisplayValue('Default instructions')).toBeInTheDocument();
      });
    });

    it('shows Save Defaults button when expanded', async () => {
      renderSection();
      fireEvent.click(await screen.findByText('Default Agent Settings'));
      expect(await screen.findByText('Save Defaults')).toBeInTheDocument();
    });

    it('Save Defaults is disabled when not dirty', async () => {
      renderSection();
      fireEvent.click(await screen.findByText('Default Agent Settings'));
      const btn = await screen.findByText('Save Defaults');
      expect(btn).toBeDisabled();
    });
  });

  describe('editing and saving', () => {
    it('enables Save when instructions change', async () => {
      renderSection();
      fireEvent.click(await screen.findByText('Default Agent Settings'));
      await screen.findByText('Default Instructions');

      const textarea = screen.getByDisplayValue('Default instructions');
      fireEvent.change(textarea, { target: { value: 'Updated instructions' } });

      expect(screen.getByText('Save Defaults')).not.toBeDisabled();
    });

    it('saves all fields on Save click', async () => {
      renderSection();
      fireEvent.click(await screen.findByText('Default Agent Settings'));
      await screen.findByText('Default Instructions');

      // Modify instructions to enable save
      const textarea = screen.getByDisplayValue('Default instructions');
      fireEvent.change(textarea, { target: { value: 'Updated instructions' } });
      fireEvent.click(screen.getByText('Save Defaults'));

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
      fireEvent.click(await screen.findByText('Default Agent Settings'));
      await screen.findByText('Free Agent Mode by default');

      const checkbox = screen.getByRole('checkbox');
      fireEvent.click(checkbox);

      expect(await screen.findByText(/skip all permission prompts/)).toBeInTheDocument();
    });
  });

  describe('clubhouse mode banner', () => {
    it('shows snapshot note when clubhouse mode is off', async () => {
      renderSection({ clubhouseMode: false });
      fireEvent.click(await screen.findByText('Default Agent Settings'));
      expect(await screen.findByText(/snapshots when new durable agents/)).toBeInTheDocument();
    });

    it('shows clubhouse mode active banner when on', async () => {
      renderSection({ clubhouseMode: true });
      fireEvent.click(await screen.findByText('Default Agent Settings'));
      expect(await screen.findByText(/Clubhouse Mode active/)).toBeInTheDocument();
      expect(screen.getByText('@@AgentName')).toBeInTheDocument();
      expect(screen.getByText('@@StandbyBranch')).toBeInTheDocument();
      expect(screen.getByText('@@Path')).toBeInTheDocument();
    });
  });

  describe('loading states', () => {
    it('returns null before loading completes', () => {
      window.clubhouse.agentSettings.readProjectAgentDefaults = vi.fn().mockReturnValue(new Promise(() => {}));
      const { container } = renderSection();
      expect(container.innerHTML).toBe('');
    });

    it('renders after load error', async () => {
      window.clubhouse.agentSettings.readProjectAgentDefaults = vi.fn().mockRejectedValue(new Error('fail'));
      renderSection();
      expect(await screen.findByText('Default Agent Settings')).toBeInTheDocument();
    });
  });
});
