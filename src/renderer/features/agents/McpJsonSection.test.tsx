import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('McpJsonSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.clubhouse.agentSettings.readMcpRawJson = vi.fn().mockResolvedValue('{\n  "mcpServers": {}\n}');
    window.clubhouse.agentSettings.getMcpShadowWarning = vi.fn().mockResolvedValue(undefined);
    window.clubhouse.agentSettings.writeMcpRawJson = vi.fn().mockResolvedValue({ ok: true });
  });

  it.each(['success', 'error'])('ignores an obsolete target read %s and keeps the current editor unavailable while loading', async (outcome) => {
    const a = deferred<string>(); const b = deferred<string>();
    window.clubhouse.agentSettings.readMcpRawJson = vi.fn().mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const view = renderSection({ agentId: 'a', worktreePath: '/a', projectPath: '/project' });
    view.rerender(<McpJsonSection agentId="b" worktreePath="/b" projectPath="/project" disabled={false} refreshKey={0} />);
    expect(screen.queryByTestId('monaco-editor')).not.toBeInTheDocument();
    await act(async () => { if (outcome === 'success') a.resolve('{"mcpServers":{"a":{"command":"A"}}}'); else a.reject(new Error('obsolete A error')); });
    expect(screen.queryByTestId('monaco-editor')).not.toBeInTheDocument();
    await act(async () => { b.resolve('{"mcpServers":{"b":{"command":"B"}}}'); });
    expect(screen.getByTestId('monaco-editor')).toHaveValue('{"mcpServers":{"b":{"command":"B"}}}');
    expect(screen.queryByText('obsolete A error')).not.toBeInTheDocument();
    fireEvent.change(screen.getByTestId('monaco-editor'), { target: { value: '{"mcpServers":{}}' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(window.clubhouse.agentSettings.writeMcpRawJson).toHaveBeenCalledWith('/b', '{"mcpServers":{}}', '/project', 'b'));
  });

  it.each(['success', 'error'])('does not apply a stale target save %s to the next agent', async (outcome) => {
    const write = deferred<{ ok: boolean }>();
    window.clubhouse.agentSettings.writeMcpRawJson = vi.fn().mockReturnValueOnce(write.promise);
    const view = renderSection({ agentId: 'a', worktreePath: '/a', projectPath: '/project' });
    await screen.findByTestId('monaco-editor');
    fireEvent.change(screen.getByTestId('monaco-editor'), { target: { value: '{"mcpServers":{"a":{"command":"A"}}}' } });
    fireEvent.click(screen.getByText('Save'));
    view.rerender(<McpJsonSection agentId="b" worktreePath="/b" projectPath="/project" disabled={false} refreshKey={0} />);
    await screen.findByTestId('monaco-editor');
    fireEvent.change(screen.getByTestId('monaco-editor'), { target: { value: '{"mcpServers":{"b":{"command":"B"}}}' } });
    await act(async () => { if (outcome === 'success') write.resolve({ ok: true }); else write.reject(new Error('obsolete A save error')); });
    expect(screen.getByTestId('monaco-editor')).toHaveValue('{"mcpServers":{"b":{"command":"B"}}}');
    expect(screen.getByText('Save')).not.toBeDisabled();
    expect(screen.queryByText('obsolete A save error')).not.toBeInTheDocument();
  });

  it('freezes the saved revision and rejects duplicate saves while same-target IPC is pending', async () => {
    const write = deferred<{ ok: boolean }>();
    window.clubhouse.agentSettings.writeMcpRawJson = vi.fn().mockReturnValueOnce(write.promise);
    const onRegisterSave = vi.fn();
    renderSection({ agentId: 'a', worktreePath: '/a', projectPath: '/project', onRegisterSave });
    await screen.findByTestId('monaco-editor');
    const saved = '{"mcpServers":{"saved":{"command":"A"}}}';
    fireEvent.change(screen.getByTestId('monaco-editor'), { target: { value: saved } });
    const handle = onRegisterSave.mock.calls.at(-1)![0];
    let first!: Promise<void>;
    await act(async () => { first = handle.save(); });
    expect(screen.getByTestId('monaco-editor')).toHaveAttribute('readonly');
    fireEvent.change(screen.getByTestId('monaco-editor'), { target: { value: '{"mcpServers":{"newer":{"command":"B"}}}' } });
    expect(screen.getByTestId('monaco-editor')).toHaveValue(saved);
    await act(async () => { await handle.save(); });
    expect(window.clubhouse.agentSettings.writeMcpRawJson).toHaveBeenCalledTimes(1);
    await act(async () => { write.resolve({ ok: true }); await first; });
    expect(screen.getByTestId('monaco-editor')).not.toHaveAttribute('readonly');
    expect(window.clubhouse.agentSettings.writeMcpRawJson).toHaveBeenCalledWith('/a', saved, '/project', 'a');
  });

  it('renders the MCP Servers heading', async () => {
    renderSection();
    expect(await screen.findByText('MCP servers')).toBeInTheDocument();
  });

  it('loads content from API', async () => {
    const customJson = '{"mcpServers": {"foo": {"command":"test"}}}';
    window.clubhouse.agentSettings.readMcpRawJson = vi.fn().mockResolvedValue(customJson);
    renderSection();

    await waitFor(() => {
      expect(window.clubhouse.agentSettings.readMcpRawJson).toHaveBeenCalledWith('/project', undefined, undefined);
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
    await screen.findByText('MCP servers');
    expect(screen.getByText('Save')).toBeDisabled();
  });

  it('Save button enables after content change with valid JSON', async () => {
    renderSection();
    await screen.findByText('MCP servers');

    const editor = screen.getByTestId('monaco-editor');
    fireEvent.change(editor, { target: { value: '{"mcpServers": {"new": {"command":"test"}}}' } });

    expect(screen.getByText('Save')).not.toBeDisabled();
  });

  it('shows JSON validation error for invalid JSON', async () => {
    renderSection();
    await screen.findByText('MCP servers');

    const editor = screen.getByTestId('monaco-editor');
    fireEvent.change(editor, { target: { value: '{invalid json' } });

    await waitFor(() => {
      // JSON.parse error message should appear
      expect(screen.getByText(/Invalid MCP JSON/i)).toBeInTheDocument();
    });
  });

  it('disables Save when JSON is invalid even if dirty', async () => {
    renderSection();
    await screen.findByText('MCP servers');

    const editor = screen.getByTestId('monaco-editor');
    fireEvent.change(editor, { target: { value: '{invalid' } });

    expect(screen.getByText('Save')).toBeDisabled();
  });

  it('saves content and clears dirty state', async () => {
    renderSection();
    await screen.findByText('MCP servers');

    const editor = screen.getByTestId('monaco-editor');
    fireEvent.change(editor, { target: { value: '{"mcpServers": {"test": {"command":"test"}}}' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => {
      expect(window.clubhouse.agentSettings.writeMcpRawJson).toHaveBeenCalledWith(
        '/project',
        '{"mcpServers": {"test": {"command":"test"}}}',
        undefined,
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
    await screen.findByText('MCP servers');

    const editor = screen.getByTestId('monaco-editor');
    fireEvent.change(editor, { target: { value: '{"mcpServers": {}}' } });
    fireEvent.click(screen.getByText('Save'));

    expect(await screen.findByText('Permission denied')).toBeInTheDocument();
  });

  it('disables Save button when disabled prop is true', async () => {
    renderSection({ disabled: true });
    await screen.findByText('MCP servers');
    expect(screen.getByText('Save')).toBeDisabled();
  });

  it('returns null before loading completes', () => {
    // Use a never-resolving promise to keep loading state
    window.clubhouse.agentSettings.readMcpRawJson = vi.fn().mockReturnValue(new Promise(() => {}));
    const { container } = renderSection();
    expect(container.innerHTML).toBe('');
  });

  it('shows an unreadable configuration without fabricating an editable empty file', async () => {
    window.clubhouse.agentSettings.readMcpRawJson = vi.fn().mockRejectedValue(new Error('fail'));
    renderSection();
    expect(await screen.findByText('MCP servers')).toBeInTheDocument();
    expect(screen.getByTestId('monaco-editor')).toHaveAttribute('readonly');
    expect(screen.getByTestId('monaco-editor')).toHaveValue('');
    expect(screen.getByText('Save')).toBeDisabled();
  });

  it('shows the shadowing warning when a GHCP config is blocked by .mcp.json precedence', async () => {
    const warning = 'Warning: .mcp.json also exists in this worktree and takes precedence over .github/mcp.json. Copilot CLI may ignore the Clubhouse materialized config here.';
    window.clubhouse.agentSettings.readMcpRawJson = vi.fn().mockResolvedValue('{\n  "mcpServers": {}\n}');
    window.clubhouse.agentSettings.getMcpShadowWarning = vi.fn().mockResolvedValue(warning);

    renderSection();

    expect(await screen.findByText(warning)).toBeInTheDocument();
  });

  describe('in the agent settings save bar', () => {
    it('drops its own Save, reports dirty and the server count, and saves through the handle', async () => {
      window.clubhouse.agentSettings.readMcpRawJson = vi.fn().mockResolvedValue('{"mcpServers":{"a":{"command":"test"},"b":{"command":"test"}}}');
      const onRegisterSave = vi.fn();
      const onDirtyChange = vi.fn();
      const onCountChange = vi.fn();
      renderSection({ onRegisterSave, onDirtyChange, onCountChange });
      await screen.findByText('MCP servers');
      expect(screen.queryByText('Save')).not.toBeInTheDocument();
      expect(onCountChange).toHaveBeenCalledWith(2);

      fireEvent.change(screen.getByTestId('monaco-editor'), { target: { value: '{"mcpServers":{"a":{"command":"test"}}}' } });
      expect(onDirtyChange).toHaveBeenLastCalledWith(true);

      const handle = onRegisterSave.mock.calls[0][0];
      await act(() => handle.save());
      expect(window.clubhouse.agentSettings.writeMcpRawJson).toHaveBeenCalledWith('/project', '{"mcpServers":{"a":{"command":"test"}}}', undefined, undefined);
      expect(onDirtyChange).toHaveBeenLastCalledWith(false);
      expect(onCountChange).toHaveBeenLastCalledWith(1);
    });

    it('rejects when the write fails or the JSON is invalid, so the bar can say so', async () => {
      window.clubhouse.agentSettings.writeMcpRawJson = vi.fn().mockResolvedValue({ ok: false, error: 'Permission denied' });
      const onRegisterSave = vi.fn();
      renderSection({ onRegisterSave });
      await screen.findByText('MCP servers');
      const handle = onRegisterSave.mock.calls[0][0];

      fireEvent.change(screen.getByTestId('monaco-editor'), { target: { value: '{"mcpServers":{}} ' } });
      await expect(act(() => handle.save())).rejects.toThrow('Permission denied');

      fireEvent.change(screen.getByTestId('monaco-editor'), { target: { value: '{bad' } });
      await expect(act(() => handle.save())).rejects.toThrow();
    });
  });
});
