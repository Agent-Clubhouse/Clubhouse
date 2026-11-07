import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../../../../shared/types';
import { McpCard, mcpRows } from './McpCard';

/** Details › MCP servers says why a server can't start, by variable name or the CLI's error line, never values (#2896). */

const agent: Agent = { id: 'a1', projectId: 'p1', name: 'scout', kind: 'durable', status: 'running', color: 'teal', orchestrator: 'claude-code' };
const m = () => window.clubhouse.managed;

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('mcpRows reasons', () => {
  it('puts the CLI\'s error under a failed server', () => {
    const { rows } = mcpRows([{ name: 'remote', status: 'failed', error: 'MCP server exited with code 1' }, { name: 'ok', status: 'connected', error: 'ignored' }], null, []);
    expect(rows.find((r) => r.name === 'remote')!.reason).toBe('MCP server exited with code 1');
    expect(rows.find((r) => r.name === 'ok')!.reason).toBeUndefined();
  });

  it('leads with a missing variable, and lists a server the CLI didn\'t report as configured with its reason', () => {
    const { rows, configuredOnly, reasons } = mcpRows(
      [{ name: 'workiq', status: 'failed', error: 'Connection closed' }],
      null,
      [],
      [{ server: 'workiq', missingEnv: ['WORKIQ_TENANT'] }, { server: 'jira', missingEnv: ['JIRA_URL', 'JIRA_USER'] }],
    );
    expect(rows[0].reason).toBe('WORKIQ_TENANT isn\'t set in your environment. Connection closed');
    expect(configuredOnly).toEqual(['jira']);
    expect(reasons.jira).toBe('JIRA_URL and JIRA_USER aren\'t set in your environment.');
  });
});

describe('McpCard', () => {
  it('shows a managed agent\'s missing variables from its status', async () => {
    vi.spyOn(m(), 'status').mockResolvedValue({ ok: true, value: {
      managed: true, running: true, waiting: false, changes: [], cliChanged: false, mcpProblems: [{ server: 'workiq', missingEnv: ['WORKIQ_TENANT'] }],
    } } as never);
    render(<McpCard agent={agent} projectPath="/work/proj" live={[{ name: 'workiq', status: 'failed' }]} spawnedAt={undefined} refreshKey={0} open onToggle={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('details-mcp-reason')).toHaveTextContent('WORKIQ_TENANT isn\'t set in your environment.'));
  });

  it('asks for no status without a project path', () => {
    const status = vi.spyOn(m(), 'status');
    render(<McpCard agent={agent} live={[{ name: 'remote', status: 'failed', error: 'exit code 127: npx: command not found' }]} spawnedAt={undefined} refreshKey={0} open onToggle={vi.fn()} />);
    expect(screen.getByTestId('details-mcp-reason')).toHaveTextContent('exit code 127: npx: command not found');
    expect(status).not.toHaveBeenCalled();
  });
});
