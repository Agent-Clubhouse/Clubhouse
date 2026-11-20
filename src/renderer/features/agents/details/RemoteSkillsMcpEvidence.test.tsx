import { render, screen, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { RemoteSkillsMcpEvidence } from './RemoteSkillsMcpEvidence';

type Props = ComponentProps<typeof RemoteSkillsMcpEvidence>;
const props = (): Props => ({
  currentRun: true, sessionAvailable: true, message: '', live: [{ name: 'shared-server', status: 'connected' }, { name: 'failed-server', status: 'failed', error: 'Safe provider failure' }],
  setup: { state: 'ok', managed: true, template: null, instructions: '1 block', skills: ['Installed skill', 'Saved skill'], mcps: ['shared-server', 'configured-server'] },
  skills: { supported: true, report: { provider: 'claude-code', driver: 'claude_agent_sdk', source: 'system/init', sessionId: 'selected-session', nativeSessionId: 'selected-native', reportedAt: 1000, names: ['provider-skill'] } },
  card: { id: 'skills-mcp', title: 'Skills and MCP', state: 'ok', summary: '', observedAt: 1000, omitted: 0, notes: ['Recorded metadata only.'], rows: [
    { label: 'Skill', value: 'Installed skill · Installation recorded by Clubhouse' },
    { label: 'Skill', value: 'Saved skill · Configured in Clubhouse' },
    { label: 'MCP configured', value: 'shared-server' }, { label: 'MCP configured', value: 'configured-server' },
    { label: 'Clubhouse MCP', value: 'Connected · 0 tools · HOST_HANDSHAKE_TIME' },
    { label: 'configured-server', value: 'Missing environment variables: HOST_VARIABLE_NAME' },
  ] },
});
const localReads = [() => window.clubhouse.managed.status, () => window.clubhouse.managed.getSetup,
  () => window.clubhouse.mcpBinding.getAgentConnection, () => window.clubhouse.agent.getDurableConfig] as const;
beforeEach(() => {
  Object.assign(window.clubhouse.managed, { status: vi.fn(), getSetup: vi.fn() });
  Object.assign(window.clubhouse.mcpBinding, { getAgentConnection: vi.fn() });
  Object.assign(window.clubhouse.agent, { getDurableConfig: vi.fn() });
});

it('separates recorded Installed, Set up, provider skills, servers and configured-only names without borrowing local inventories', () => {
  render(<RemoteSkillsMcpEvidence {...props()} />);
  expect(within(screen.getByRole('list', { name: 'Installed by Clubhouse' })).getAllByRole('listitem')).toHaveLength(1);
  expect(screen.getByRole('list', { name: 'Installed by Clubhouse' })).toHaveTextContent('Installed skill · Installation recorded by Clubhouse');
  expect(screen.getByRole('list', { name: 'Set up by Clubhouse' })).toHaveTextContent('Saved skill · Configured in Clubhouse');
  expect(screen.getByRole('region', { name: 'Installed by Clubhouse' })).toHaveTextContent('provider loading, use and execution are not verified');
  expect(screen.getByRole('region', { name: 'Set up by Clubhouse' })).toHaveTextContent('next start');
  expect(screen.getByRole('list', { name: 'Provider-reported skill names' })).toHaveTextContent('provider-skill');
  expect(screen.getByRole('region', { name: 'Provider-reported skills' })).toHaveTextContent('selected-session');
  const servers = screen.getByRole('list', { name: 'Provider-reported MCP servers' });
  expect(servers).toHaveTextContent('shared-server'); expect(servers).toHaveTextContent('Connected');
  expect(servers).toHaveTextContent('failed-server'); expect(servers).toHaveTextContent('Safe provider failure');
  const configured = screen.getByRole('list', { name: 'Configured-only MCP servers' });
  expect(within(configured).getAllByRole('listitem')).toHaveLength(1);
  expect(configured).toHaveTextContent('configured-server'); expect(configured).not.toHaveTextContent('shared-server');
  expect(screen.getByRole('region', { name: 'Host Clubhouse MCP handshake' })).toHaveTextContent('Connected · 0 tools · HOST_HANDSHAKE_TIME');
  expect(screen.getByText('Missing environment variables: HOST_VARIABLE_NAME')).toBeInTheDocument();
  expect(screen.getByRole('region', { name: 'Wires' })).toHaveTextContent('Wiring is unknown here');
  for (const get of localReads) expect(get()).not.toHaveBeenCalled();
});

it.each(['missing', 'empty', 'unsupported', 'malformed'] as const)('distinguishes absent and explicit-empty provider inventories: %s', (mode) => {
  const p = props(); p.live = mode === 'empty' ? [] : null;
  p.skills = { supported: mode !== 'unsupported', report: mode === 'empty' || mode === 'malformed' ? { ...p.skills.report!, names: mode === 'empty' ? [] : null } : null };
  render(<RemoteSkillsMcpEvidence {...p} />);
  const skills = screen.getByRole('region', { name: 'Provider-reported skills' });
  expect(skills).toHaveTextContent(mode === 'empty' ? 'Claude explicitly reported no skills' : mode === 'unsupported' ? 'does not report loaded skill names' : mode === 'malformed' ? 'Skill names were not reported' : 'No valid skills report');
  expect(screen.getByRole('region', { name: 'MCP servers' })).toHaveTextContent(mode === 'empty' ? 'provider explicitly reported no MCP connections' : 'provider has not reported its MCP connections');
  expect(screen.getByRole('list', { name: 'Configured-only MCP servers' })).toHaveTextContent('shared-server');
  expect(screen.queryByRole('list', { name: 'Provider-reported MCP servers' })).not.toBeInTheDocument();
});

it('retains old-host/unrecognized display text and omissions without guessing installation or a typed wire', () => {
  const p = props(); p.setup = undefined; p.live = null; p.skills = { supported: false, report: null };
  p.card = { ...p.card!, omitted: 7, rows: [
    { label: 'Skill', value: 'Custom legacy skill status' },
    { label: 'Wired to', value: 'FAKE_AGENT · agent · outgoing binding recorded in host memory' },
    { label: 'MCP configured', value: 'safe-configured-name' },
  ] };
  render(<RemoteSkillsMcpEvidence {...p} />);
  expect(screen.getByText('Custom legacy skill status')).toBeInTheDocument();
  expect(screen.queryByRole('list', { name: 'Installed by Clubhouse' })).not.toBeInTheDocument();
  expect(screen.queryByRole('list', { name: 'Set up by Clubhouse' })).not.toBeInTheDocument();
  expect(screen.getByRole('list', { name: 'Configured-only MCP servers' })).toHaveTextContent('safe-configured-name');
  expect(screen.getByText('FAKE_AGENT · agent · outgoing binding recorded in host memory')).toBeInTheDocument();
  expect(screen.getByRole('region', { name: 'Wires' })).not.toHaveTextContent('FAKE_AGENT');
  expect(screen.getByText(/7 more rows omitted/)).toBeInTheDocument();
});

it('keeps current-run installation/handshake claims out of unconfirmed or stopped presentation', () => {
  render(<RemoteSkillsMcpEvidence {...props()} currentRun={false} live={null} skills={{ supported: false, report: null }} sessionAvailable={false} />);
  expect(screen.queryByRole('list', { name: 'Installed by Clubhouse' })).not.toBeInTheDocument();
  expect(screen.queryByRole('region', { name: 'Host Clubhouse MCP handshake' })).not.toBeInTheDocument();
  expect(screen.queryByText(/HOST_HANDSHAKE_TIME/)).not.toBeInTheDocument();
  expect(screen.getByText('Installed skill · Installation recorded by Clubhouse')).toBeInTheDocument();
  expect(screen.getByRole('region', { name: 'Provider-reported skills' })).toHaveTextContent('current authorized session read');
});

it.each(['error', 'unsupported', 'unrequested'] as const)('preserves section limitations and never manufactures empty inventory for %s evidence', (mode) => {
  const p = props(); p.setup = undefined; p.live = null; p.skills = { supported: false, report: null };
  p.card = { ...p.card!, rows: [], state: mode === 'unrequested' ? 'ok' : mode, ...(mode === 'unrequested' && { requested: false }) };
  render(<RemoteSkillsMcpEvidence {...p} />);
  if (mode === 'unrequested') {
    expect(screen.getByText(/not included in the selected Connections page/)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Skills' })).not.toBeInTheDocument();
  } else {
    expect(screen.getByText(mode === 'error' ? 'Couldn’t read this section from the host.' : 'This host does not support sharing this section.')).toBeInTheDocument();
    expect(screen.getByText(/Missing names are unknown/)).toBeInTheDocument();
    expect(screen.getByText(/No empty inventory is inferred/)).toBeInTheDocument();
  }
});

it('shows saved typed setup names without inferring installation when older host rows omit skill status', () => {
  const p = props(); p.card = { ...p.card!, rows: [] };
  render(<RemoteSkillsMcpEvidence {...p} />);
  expect(screen.getByRole('list', { name: 'Set up by Clubhouse' })).toHaveTextContent('Installed skill');
  expect(screen.queryByRole('list', { name: 'Installed by Clubhouse' })).not.toBeInTheDocument();
});

it('distinguishes a known empty configured list and renders reported names literally without executing markup', () => {
  const p = props(); p.card = { ...p.card!, rows: [] }; p.setup = { ...p.setup!, mcps: [] };
  p.live = [{ name: '<script>provider-server</script>', status: 'pending' }];
  p.skills.report = { ...p.skills.report!, names: ['<img src=x onerror=alert(1)>'] };
  const { container } = render(<RemoteSkillsMcpEvidence {...p} />);
  expect(screen.getByText('The host explicitly shared no configured MCP names.')).toBeInTheDocument();
  expect(screen.getByText('<script>provider-server</script>')).toBeInTheDocument();
  expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
  expect(container.querySelector('script, img')).toBeNull();
  expect(screen.queryByRole('list', { name: 'Configured-only MCP servers' })).not.toBeInTheDocument();
});
