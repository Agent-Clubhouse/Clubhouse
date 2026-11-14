import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ConnectionPicker, validateTypedAddress } from './ConnectionPicker';
import { useDispatcherDebugStore } from '../../dispatcher/dispatcherDebug';
import type { ConnectionPickerDirectory } from '../../../../shared/connection-picker';

const machine = Array(16).fill('ab').join(':');
const old = Array(16).fill('cd').join(':');
const unknown = Array(16).fill('ef').join(':');
const directory: ConnectionPickerDirectory = {
  machines: [{ id: machine, name: 'Studio', network: true }, { id: old, name: 'Old', network: false }],
  targets: [
    { id: 'b', name: 'Beta', kind: 'agent', project: 'Project B' },
    { id: 'c', name: 'Gamma', kind: 'agent', project: 'Project C', machineId: machine, machineName: 'Studio', online: false },
    { id: 'd', name: 'Dispatcher', kind: 'dispatcher', routeId: 'work' },
    { id: 'work', name: 'Dispatcher controller', kind: 'agent', controllerOf: 'd' },
    { id: 'g', name: 'Group', kind: 'group-project' },
  ],
};

beforeEach(() => {
  useDispatcherDebugStore.setState({ on: false });
  window.clubhouse.mcpBinding.listCardTargets = vi.fn().mockResolvedValue(directory);
  window.clubhouse.mcpBinding.addCardConnection = vi.fn().mockResolvedValue(undefined);
});

it('groups and searches targets, keeps offline agents selectable and disables connected targets', async () => {
  render(<ConnectionPicker agentId="a" agentName="Alpha" bindings={[{ agentId: 'a', targetId: 'b', targetKind: 'agent', label: 'Beta' }]} grants={[]} onClose={vi.fn()} onCreated={vi.fn()} />);
  expect(await screen.findByRole('heading', { name: 'Project B' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Studio' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Project C' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Beta/ })).toBeDisabled();
  expect(screen.getByRole('button', { name: /Gamma/ })).toBeEnabled();
  expect(screen.getByRole('button', { name: /Gamma/ })).toHaveTextContent('Offline');
  fireEvent.change(screen.getByLabelText('Search targets'), { target: { value: 'gamma' } });
  expect(screen.queryByRole('button', { name: /Beta/ })).not.toBeInTheDocument();
});

it('saves a one-way remote connection with chosen switches', async () => {
  const created = vi.fn();
  render(<ConnectionPicker agentId="a" agentName="Alpha" bindings={[]} grants={[]} onClose={vi.fn()} onCreated={created} />);
  fireEvent.click(await screen.findByRole('button', { name: /Gamma/ }));
  fireEvent.click(screen.getByLabelText('One way'));
  fireEvent.click(screen.getByRole('switch', { name: /Clear its context Alpha to Gamma/ }));
  fireEvent.click(within(screen.getByTestId('connection-picker')).getByRole('button', { name: 'Add connection' }));
  await waitFor(() => expect(window.clubhouse.mcpBinding.addCardConnection).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'a', targetId: 'c', machineId: machine, twoWay: false, allow: expect.arrayContaining(['clear_agent']) })));
  expect(created).toHaveBeenCalledWith(directory.targets[1]);
});

it('distinguishes malformed, unknown, and non-network addresses', () => {
  expect(validateTypedAddress('bad', directory).error).toMatch(/Enter an address/);
  expect(validateTypedAddress(`c@${unknown}`, directory).error).toMatch(/not known/);
  expect(validateTypedAddress(`c@${old}`, directory).error).toMatch(/not a computer/);
  expect(validateTypedAddress(`missing@${machine}`, directory).error).toMatch(/No agent/);
  expect(validateTypedAddress(`c@${machine}`, directory).target).toEqual(directory.targets[1]);
});

it('offers Dispatchers and group projects and saves group membership', async () => {
  const created = vi.fn();
  render(<ConnectionPicker agentId="a" agentName="Alpha" bindings={[]} grants={[]} onClose={vi.fn()} onCreated={created} />);
  expect(await screen.findByRole('button', { name: /Dispatcher\s*This computer/ })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: 'Group' }));
  expect(screen.getByText('Alpha will join this group project.')).toBeInTheDocument();
  fireEvent.click(within(screen.getByTestId('connection-picker')).getByRole('button', { name: 'Add connection' }));
  await waitFor(() => expect(window.clubhouse.mcpBinding.addCardConnection).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'a', targetId: 'g', targetKind: 'group-project' })));
  expect(created).toHaveBeenCalledWith(directory.targets[4]);
});

it('shows the controller under its Dispatcher only with Debug on', async () => {
  const view = render(<ConnectionPicker agentId="a" agentName="Alpha" bindings={[]} grants={[]} onClose={vi.fn()} onCreated={vi.fn()} />);
  expect(await screen.findByRole('button', { name: /Dispatcher\s*This computer/ })).toBeEnabled();
  expect(screen.queryByTestId('connection-picker-controller')).toBeNull();
  view.unmount();
  useDispatcherDebugStore.setState({ on: true });
  render(<ConnectionPicker agentId="a" agentName="Alpha" bindings={[]} grants={[]} onClose={vi.fn()} onCreated={vi.fn()} />);
  const controller = await screen.findByTestId('connection-picker-controller');
  expect(controller).toHaveTextContent('Dispatcher controller');
  expect(controller.parentElement).toContainElement(screen.getByRole('button', { name: /Dispatcher\s*This computer/ }));
  useDispatcherDebugStore.setState({ on: false });
});

it('recognizes an existing controller connection on the visible Dispatcher', async () => {
  render(<ConnectionPicker agentId="a" agentName="Alpha" bindings={[{ agentId: 'a', targetId: 'work', targetKind: 'agent', label: 'Dispatcher' }]} grants={[]} onClose={vi.fn()} onCreated={vi.fn()} />);
  expect(await screen.findByRole('button', { name: /Dispatcher\s*This computer/ })).toBeDisabled();
});
