import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpJsonSection } from './McpJsonSection';

vi.mock('../../components/SettingsMonacoEditor', () => ({
  SettingsMonacoEditor: ({ value, onChange, readOnly }: any) => (
    <textarea
      data-testid="monaco-editor"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      readOnly={readOnly}
    />
  ),
}));

function renderSection(overrides: Partial<React.ComponentProps<typeof McpJsonSection>> = {}) {
  return render(
    <McpJsonSection
      worktreePath="/project"
      disabled={false}
      refreshKey={0}
      {...overrides}
    />,
  );
}

describe('McpJsonSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.clubhouse.agentSettings.readMcpRawJson = vi.fn().mockResolvedValue('{\n  "mcpServers": {}\n}');
    window.clubhouse.agentSettings.writeMcpRawJson = vi.fn().mockResolvedValue({ ok: true });
  });

  it('renders the MCP Servers heading', async () => {
    renderSection();
    expect(await screen.findByText('MCP Servers')).toBeInTheDocument();
  });

  it('loads content from API', async () => {
    const customJson = '{"mcpServers": {"foo": {}}}';
    window.clubhouse.agentSettings.readMcpRawJson = vi.fn().mockResolvedValue(customJson);
    renderSection();

    await waitFor(() => {
      expect(window.clubhouse.agentSettings.readMcpRawJson).toHaveBeenCalledWith('/project', undefined);
    });
  });

  it('shows default path label', async () => {
    renderSection();
    expect(await screen.findByText('.mcp.json')).toBeInTheDocument();
  });

  it('shows custom path label', async () => {
    renderSection({ pathLabel: '.codex/mcp.json' });
    expect(await screen.findByText('.codex/mcp.json')).toBeInTheDocument();
  });

  it('Save button is disabled when content is not dirty', async () => {
    renderSection();
    await screen.findByText('MCP Servers');
    expect(screen.getByText('Save')).toBeDisabled();
  });

  it('Save button enables after content change with valid JSON', async () => {
    renderSection();
    await screen.findByText('MCP Servers');

    const editor = screen.getByTestId('monaco-editor');
    fireEvent.change(editor, { target: { value: '{"mcpServers": {"new": {}}}' } });

    expect(screen.getByText('Save')).not.toBeDisabled();
  });

  it('shows JSON validation error for invalid JSON', async () => {
    renderSection();
    await screen.findByText('MCP Servers');

    const editor = screen.getByTestId('monaco-editor');
    fireEvent.change(editor, { target: { value: '{invalid json' } });

    await waitFor(() => {
      // JSON.parse error message should appear
      expect(screen.getByText(/Expected property name|Unexpected token/i)).toBeTruthy();
    });
  });

  it('disables Save when JSON is invalid even if dirty', async () => {
    renderSection();
    await screen.findByText('MCP Servers');

    const editor = screen.getByTestId('monaco-editor');
    fireEvent.change(editor, { target: { value: '{invalid' } });

    expect(screen.getByText('Save')).toBeDisabled();
  });

  it('saves content and clears dirty state', async () => {
    renderSection();
    await screen.findByText('MCP Servers');

    const editor = screen.getByTestId('monaco-editor');
    fireEvent.change(editor, { target: { value: '{"mcpServers": {"test": {}}}' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => {
      expect(window.clubhouse.agentSettings.writeMcpRawJson).toHaveBeenCalledWith(
        '/project',
        '{"mcpServers": {"test": {}}}',
        undefined,
      );
    });
  });

  it('shows error from failed save', async () => {
    window.clubhouse.agentSettings.writeMcpRawJson = vi.fn().mockResolvedValue({
      ok: false,
      error: 'Permission denied',
    });

    renderSection();
    await screen.findByText('MCP Servers');

    const editor = screen.getByTestId('monaco-editor');
    fireEvent.change(editor, { target: { value: '{"mcpServers": {}}' } });
    fireEvent.click(screen.getByText('Save'));

    expect(await screen.findByText('Permission denied')).toBeInTheDocument();
  });

  it('disables Save button when disabled prop is true', async () => {
    renderSection({ disabled: true });
    await screen.findByText('MCP Servers');
    expect(screen.getByText('Save')).toBeDisabled();
  });

  it('returns null before loading completes', () => {
    // Use a never-resolving promise to keep loading state
    window.clubhouse.agentSettings.readMcpRawJson = vi.fn().mockReturnValue(new Promise(() => {}));
    const { container } = renderSection();
    expect(container.innerHTML).toBe('');
  });

  it('falls back to default JSON on load error', async () => {
    window.clubhouse.agentSettings.readMcpRawJson = vi.fn().mockRejectedValue(new Error('fail'));
    renderSection();
    // Should still render after error
    expect(await screen.findByText('MCP Servers')).toBeInTheDocument();
  });
});
