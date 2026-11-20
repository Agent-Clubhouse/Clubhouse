import { render, screen, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import { REMOTE_OUTGOING_WIRE_KINDS, type RemoteOutgoingWires } from '../../../../shared/remote-agent-details';
import { RemoteOutgoingWiresEvidence } from './RemoteOutgoingWiresEvidence';

it('shows only recorded names and kinds, including unknown names, without live or authority claims or navigation', () => {
  render(<RemoteOutgoingWiresEvidence wires={{ source: 'selected-outgoing-binding-records', state: 'recorded', total: 5, omitted: 0,
    rows: REMOTE_OUTGOING_WIRE_KINDS.map((kind) => ({ kind, name: kind === 'agent' ? null : `Safe ${kind}` })),
  }} />);
  const list = screen.getByRole('list', { name: 'Recorded outgoing wires' });
  expect(within(list).getAllByRole('listitem')).toHaveLength(5);
  expect(list).toHaveTextContent('Name unavailable from host'); expect(list).toHaveTextContent('group project');
  expect(screen.getByText(/These records do not establish health, reachability, authorization or a live connection/)).toBeInTheDocument();
  expect(screen.getByText('5 of 5 recorded outgoing bindings shown.')).toBeInTheDocument();
  expect(within(list).queryByRole('button')).not.toBeInTheDocument(); expect(within(list).queryByRole('link')).not.toBeInTheDocument();
  expect(list).not.toHaveTextContent(/Connected|Healthy|Authorized/);
});

it('retains bounded omissions without implying a complete list or hiding unnamed records', () => {
  render(<RemoteOutgoingWiresEvidence wires={{ source: 'selected-outgoing-binding-records', state: 'recorded', total: 52, omitted: 50, rows: [{ kind: 'agent', name: null }, { kind: 'plugin', name: 'Safe plugin' }] }} />);
  expect(screen.getByText('2 of 52 recorded outgoing bindings shown.')).toBeInTheDocument();
  expect(screen.getByText(/50 additional outgoing binding records omitted/)).toHaveTextContent('No complete wire list is claimed.');
  expect(screen.getByText('Recorded wire to Name unavailable from host')).toBeInTheDocument();
});

it('shows verified empty host records as a record observation rather than no connections', () => {
  render(<RemoteOutgoingWiresEvidence wires={{ source: 'selected-outgoing-binding-records', state: 'recorded', total: 0, omitted: 0, rows: [] }} />);
  expect(screen.getByText('The host recorded no outgoing bindings for this selected agent.')).toBeInTheDocument();
  expect(screen.queryByRole('list')).not.toBeInTheDocument();
  expect(screen.queryByText(/no connections/i)).not.toBeInTheDocument();
});

it.each(['unreadable', 'invalid', 'limit', 'changed'] as const)('preserves unavailable %s instead of inferring empty or retaining rows', (reason) => {
  const { rerender } = render(<RemoteOutgoingWiresEvidence wires={{ source: 'selected-outgoing-binding-records', state: 'recorded', total: 1, omitted: 0, rows: [{ name: 'Earlier private name', kind: 'agent' }] }} />);
  rerender(<RemoteOutgoingWiresEvidence wires={{ source: 'selected-outgoing-binding-records', state: 'unavailable', reason }} />);
  expect(screen.getByText(/Wiring is unknown here/)).toBeInTheDocument();
  expect(screen.queryByText(/Earlier private name|recorded no outgoing bindings/)).not.toBeInTheDocument();
  expect(screen.queryByRole('list')).not.toBeInTheDocument();
});

it.each([undefined, { source: 'selected-outgoing-binding-records', state: 'recorded', total: 1, omitted: 0, rows: [{ name: 'Untrusted name', kind: 'agent', targetId: 'PRIVATE_RAW_ID' }] }])('keeps absent old-host or expanded invalid evidence unknown without raw ID fallback', (wires) => {
  const { container } = render(<RemoteOutgoingWiresEvidence wires={wires as RemoteOutgoingWires | undefined} />);
  expect(screen.getByText(/Wiring is unknown here/)).toBeInTheDocument();
  expect(container.innerHTML).not.toMatch(/PRIVATE_RAW_ID|Untrusted name/);
  expect(screen.queryByRole('list')).not.toBeInTheDocument();
});

it('escapes names as text without turning host records into markup or commands', () => {
  const { container } = render(<RemoteOutgoingWiresEvidence wires={{ source: 'selected-outgoing-binding-records', state: 'recorded', total: 1, omitted: 0, rows: [{ name: '<script>host-record</script>', kind: 'browser' }] }} />);
  expect(screen.getByText('Recorded wire to <script>host-record</script>')).toBeInTheDocument();
  expect(container.querySelector('script')).toBeNull();
});
