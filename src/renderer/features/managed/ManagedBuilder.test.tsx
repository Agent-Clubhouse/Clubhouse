import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManagedPartConsumer, ManagedPartSummary } from '../../../shared/managed-agents-types';
import { BlockList } from './BlockList';
import { LibraryPanel, PartToggleList } from './LibraryPanel';
import { ImpactDialog } from './ImpactDialog';
import { ManagedBuilder, PreviewPane } from './ManagedBuilder';
import { PartDialog } from './PartDialog';
import { ManagedGeneralSection, convertSummary } from './ManagedGeneralSection';
import { useToastStore } from '../../stores/toastStore';
import { NO_SESSION_NOTE, requestManagedRestart, resetPendingRestarts } from './restart';

const consumer = (agentId: string, running = false): ManagedPartConsumer => ({
  projectPath: '/p', projectName: 'Clubhouse', agentId, agentName: agentId, color: 'indigo', running,
});

function part(id: string, over: Partial<ManagedPartSummary> = {}): ManagedPartSummary {
  return {
    id, kind: 'block', name: id, description: '', builtin: false, revision: 1, updatedAt: '', usedBy: [], templates: [], preview: `${id} text`,
    ...over,
  };
}

const agent = { projectPath: '/p', agentId: 'release-lead', agentName: 'release-lead' };
const m = () => window.clubhouse.managed;

beforeEach(() => {
  vi.restoreAllMocks();
  resetPendingRestarts();
  useToastStore.setState({ toasts: [] });
});

const toasts = () => useToastStore.getState().toasts.map((t) => `${t.type}: ${t.message}`);

describe('BlockList', () => {
  it('reorders with the arrow keys and says where the block went', () => {
    const onChange = vi.fn();
    render(<BlockList blocks={['a', 'b', 'c']} parts={[part('a'), part('b'), part('c')]} agent={agent} onChange={onChange} onFork={vi.fn()} onWrite={vi.fn()} />);
    fireEvent.keyDown(screen.getByRole('button', { name: /Move b/ }), { key: 'ArrowUp' });
    expect(onChange).toHaveBeenCalledWith(['b', 'a', 'c']);
    expect(screen.getByRole('status').textContent).toMatch(/b moved to position 1 of 3/);
  });

  it('labels where each block comes from and offers only a copy for a built-in', () => {
    render(<BlockList
      blocks={['id', 'shared', 'mine']}
      parts={[part('id', { name: 'Identity', builtin: true }), part('shared', { usedBy: [consumer('release-lead'), consumer('ada'), consumer('scout')] }), part('mine', { usedBy: [consumer('release-lead')] })]}
      agent={agent} onChange={vi.fn()} onFork={vi.fn()} onWrite={vi.fn()}
    />);
    const [builtin, shared, mine] = screen.getAllByTestId('managed-block');
    expect(builtin.textContent).toContain('Built-in');
    expect(within(builtin).queryByRole('button', { name: /^Edit/ })).toBeNull();
    expect(within(builtin).getByRole('button', { name: 'Make your copy of Identity' })).toBeTruthy();
    expect(within(shared).getByRole('button', { name: 'Fork shared' })).toBeTruthy();
    expect(shared.textContent).toContain('Custom · 3 agents');
    expect(mine.textContent).toContain('release-lead only');
  });

  it('editing a shared block says so, and saving asks who it reaches first', async () => {
    vi.spyOn(m(), 'getPart').mockResolvedValue({ ok: true, value: { ...part('shared'), content: { kind: 'block', content: 'old' } } } as never);
    const update = vi.spyOn(m(), 'updatePart').mockResolvedValue({ ok: true, value: part('shared', { revision: 2 }) } as never);
    const restart = vi.spyOn(m(), 'restart');
    render(<BlockList blocks={['shared']} parts={[part('shared', { usedBy: [consumer('release-lead', true), consumer('ada')] })]} agent={agent} onChange={vi.fn()} onFork={vi.fn()} onWrite={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit shared' }));
    const text = await screen.findByRole('textbox');
    expect(screen.getByText(/You're editing shared for 2 agents/)).toBeTruthy();
    expect(screen.getByTestId('managed-wildcards')).toBeTruthy();
    fireEvent.change(text, { target: { value: 'new' } });
    fireEvent.click(screen.getByTestId('managed-block-save'));
    const dialog = await screen.findByTestId('managed-impact-dialog');
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Restart release-lead' }));
    fireEvent.click(within(dialog).getByTestId('managed-impact-save'));
    await waitFor(() => expect(update).toHaveBeenCalledWith({ id: 'shared', expectedRevision: 1, content: { kind: 'block', content: 'new' } }));
    // Idle: restarted now, through the restart helper.
    await waitFor(() => expect(restart).toHaveBeenCalledWith('/p', 'release-lead', {}));
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  const openSharedEditor = async (onFork: () => Promise<string | undefined> = vi.fn()) => {
    vi.spyOn(m(), 'getPart').mockResolvedValue({ ok: true, value: { ...part('shared'), content: { kind: 'block', content: 'old' } } } as never);
    render(<BlockList blocks={['shared']} parts={[part('shared', { usedBy: [consumer('release-lead', true), consumer('ada')] })]} agent={agent} onChange={vi.fn()} onFork={onFork} onWrite={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit shared' }));
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: 'new' } });
  };

  it('a working agent ticked for restart waits for its turn to end, and the editor closes on save', async () => {
    const update = vi.spyOn(m(), 'updatePart').mockResolvedValue({ ok: true, value: part('shared', { revision: 2 }) } as never);
    vi.spyOn(m(), 'isWorking').mockResolvedValue({ ok: true, value: true } as never);
    let finish: (v: unknown) => void = () => {};
    const restart = vi.spyOn(m(), 'restart').mockImplementation(() => new Promise((r) => { finish = r; }) as never);
    await openSharedEditor();
    fireEvent.click(screen.getByTestId('managed-block-save'));
    const dialog = await screen.findByTestId('managed-impact-dialog');
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Restart release-lead' }));
    fireEvent.click(within(dialog).getByTestId('managed-impact-save'));
    await waitFor(() => expect(update).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId('managed-impact-dialog')).toBeNull());
    expect(screen.queryByRole('textbox')).toBeNull();
    await waitFor(() => expect(restart).toHaveBeenCalledWith('/p', 'release-lead', { whenTurnEnds: true }));
    expect(toasts()).toContain('info: release-lead restarts when this turn ends.');
    await act(async () => { finish({ ok: true, value: { resumed: true } }); });
  });

  it('a failed restart is its own toast and the save still stands', async () => {
    vi.spyOn(m(), 'updatePart').mockResolvedValue({ ok: true, value: part('shared', { revision: 2 }) } as never);
    vi.spyOn(m(), 'restart').mockResolvedValue({ ok: false, code: 'failed', message: 'The CLI did not stop.' } as never);
    await openSharedEditor();
    fireEvent.click(screen.getByTestId('managed-block-save'));
    const dialog = await screen.findByTestId('managed-impact-dialog');
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Restart release-lead' }));
    fireEvent.click(within(dialog).getByTestId('managed-impact-save'));
    await waitFor(() => expect(toasts()).toContain("error: Couldn't restart release-lead. The CLI did not stop."));
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a failed save keeps the editor open with the text and restarts nobody', async () => {
    vi.spyOn(m(), 'updatePart').mockResolvedValue({ ok: false, code: 'stale' } as never);
    const restart = vi.spyOn(m(), 'restart');
    await openSharedEditor();
    fireEvent.click(screen.getByTestId('managed-block-save'));
    const dialog = await screen.findByTestId('managed-impact-dialog');
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Restart release-lead' }));
    fireEvent.click(within(dialog).getByTestId('managed-impact-save'));
    expect((await within(dialog).findByRole('alert')).textContent).toMatch(/changed since you opened it/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('new');
    expect(restart).not.toHaveBeenCalled();
  });

  it('fork instead keeps the editor and the text when the fork fails', async () => {
    const update = vi.spyOn(m(), 'updatePart');
    await openSharedEditor(vi.fn(async () => undefined));
    fireEvent.click(screen.getByRole('button', { name: 'Fork for release-lead instead' }));
    await act(async () => { await Promise.resolve(); });
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('new');
    expect(update).not.toHaveBeenCalled();
  });

  it('fork instead keeps the edit on the copy and leaves the shared block alone', async () => {
    vi.spyOn(m(), 'getPart').mockImplementation(async (id: string) => ({ ok: true, value: { ...part(id), content: { kind: 'block', content: 'old' } } }) as never);
    const update = vi.spyOn(m(), 'updatePart').mockResolvedValue({ ok: true, value: part('copy') } as never);
    const onFork = vi.fn(async () => 'copy');
    render(<BlockList blocks={['shared']} parts={[part('shared', { usedBy: [consumer('release-lead'), consumer('ada')] })]} agent={agent} onChange={vi.fn()} onFork={onFork} onWrite={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit shared' }));
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: 'just mine' } });
    fireEvent.click(screen.getByRole('button', { name: 'Fork for release-lead instead' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith({ id: 'copy', expectedRevision: 1, content: { kind: 'block', content: 'just mine' } }));
    expect(update).not.toHaveBeenCalledWith(expect.objectContaining({ id: 'shared' }));
  });

  it('shows a block that no longer exists so it can be removed', () => {
    const onChange = vi.fn();
    render(<BlockList blocks={['gone']} parts={[]} agent={agent} onChange={onChange} onFork={vi.fn()} onWrite={vi.fn()} />);
    expect(screen.getByText(/no longer exists/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(onChange).toHaveBeenCalledWith([]);
  });
});

describe('PartToggleList', () => {
  it('switches a skill on and off for the agent', () => {
    const onToggle = vi.fn();
    render(<PartToggleList kind="skill" parts={[part('notes', { kind: 'skill', name: 'Notes' })]} selected={[]} agent={agent} onToggle={onToggle} onFork={vi.fn()} onEdit={vi.fn()} onNew={vi.fn()} />);
    fireEvent.click(screen.getByRole('switch', { name: 'Notes' }));
    expect(onToggle).toHaveBeenCalledWith('notes', true);
  });
});

describe('ImpactDialog', () => {
  it('offers restart only for running agents and says restart keeps the conversation', () => {
    render(<ImpactDialog open partName="Rules" consumers={[consumer('a', true), consumer('b')]} onSave={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
    expect(screen.getByText(/Restart keeps the conversation. The new setup applies from the next turn./)).toBeTruthy();
  });
});

describe('ManagedBuilder', () => {
  it('adds a block from the library to a draft', async () => {
    vi.spyOn(m(), 'listParts').mockImplementation(async (kind: string) => ({ ok: true, value: kind === 'block' ? [part('identity', { name: 'Identity', builtin: true })] : [] }) as never);
    const onChange = vi.fn();
    render(<ManagedBuilder target={{ kind: 'draft', value: { blocks: [], skills: [], mcps: [] }, onChange, agentName: 'cool-gazelle' }} tab="instructions" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add Identity' }));
    expect(onChange).toHaveBeenCalledWith({ blocks: ['identity'], skills: [], mcps: [] });
    expect(screen.getByTestId('managed-blocks-empty')).toBeTruthy();
  });

  it('saves an existing agent\'s setup on each change', async () => {
    vi.spyOn(m(), 'listParts').mockImplementation(async (kind: string) => ({ ok: true, value: kind === 'skill' ? [part('notes', { kind: 'skill', name: 'Notes' })] : [] }) as never);
    vi.spyOn(m(), 'getSetup').mockResolvedValue({ ok: true, value: { version: 1, blocks: [], skills: [], mcps: [] } } as never);
    const save = vi.spyOn(m(), 'saveSetup').mockResolvedValue({ ok: true, value: { version: 1, blocks: [], skills: ['notes'], mcps: [] } } as never);
    render(<ManagedBuilder target={{ kind: 'agent', agent }} tab="skills" />);
    fireEvent.click(await screen.findByRole('switch', { name: 'Notes' }));
    await waitFor(() => expect(save).toHaveBeenCalledWith('/p', 'release-lead', { blocks: [], skills: ['notes'], mcps: [] }));
  });
});

describe('ManagedBuilder setup loading', () => {
  it('loads once per agent, not on every render', async () => {
    const getSetup = vi.spyOn(m(), 'getSetup').mockResolvedValue({ ok: true, value: { version: 1, blocks: [], skills: [], mcps: [] } } as never);
    const { rerender } = render(<ManagedBuilder target={{ kind: 'agent', agent: { ...agent } }} tab="skills" />);
    await screen.findByTestId('managed-builder-skills');
    const loads = getSetup.mock.calls.length;
    rerender(<ManagedBuilder target={{ kind: 'agent', agent: { ...agent } }} tab="skills" />);
    rerender(<ManagedBuilder target={{ kind: 'agent', agent: { ...agent } }} tab="skills" />);
    await act(async () => { await Promise.resolve(); });
    expect(getSetup.mock.calls.length).toBe(loads);
  });

  it('a load that started before a save can\'t put the older setup back', async () => {
    vi.spyOn(m(), 'listParts').mockImplementation(async (kind: string) => ({ ok: true, value: kind === 'skill' ? [part('notes', { kind: 'skill', name: 'Notes' })] : [] }) as never);
    const listeners: Array<() => void> = [];
    const changed = () => listeners.forEach((l) => l());
    vi.spyOn(m(), 'onChanged').mockImplementation((l: () => void) => { listeners.push(l); return () => {}; });
    const empty = { version: 1, blocks: [], skills: [], mcps: [] };
    let answerLate: (v: unknown) => void = () => {};
    const getSetup = vi.spyOn(m(), 'getSetup').mockResolvedValueOnce({ ok: true, value: empty } as never);
    vi.spyOn(m(), 'saveSetup').mockResolvedValue({ ok: true, value: { ...empty, skills: ['notes'] } } as never);
    render(<ManagedBuilder target={{ kind: 'agent', agent }} tab="skills" />);
    const toggle = await screen.findByRole('switch', { name: 'Notes' });
    // Something else changed: a reload starts, and answers only after the save below.
    getSetup.mockImplementationOnce(() => new Promise((r) => { answerLate = r; }) as never);
    act(() => changed());
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Notes' }).getAttribute('aria-checked')).toBe('true'));
    await act(async () => { answerLate({ ok: true, value: empty }); });
    expect(screen.getByRole('switch', { name: 'Notes' }).getAttribute('aria-checked')).toBe('true');
  });
});

describe('PartDialog', () => {
  it('creates a block with its wildcards shown and hands it back to add', async () => {
    const created = part('new', { name: 'Rules' });
    const create = vi.spyOn(m(), 'createPart').mockResolvedValue({ ok: true, value: created } as never);
    const onCreated = vi.fn();
    render(<PartDialog open kind="block" agentName="cool-gazelle" onClose={vi.fn()} onCreated={onCreated} />);
    expect(screen.getByTestId('managed-wildcards').textContent).toContain('@@AgentName');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Rules' } });
    fireEvent.change(screen.getByLabelText('Block text'), { target: { value: 'Use strict mode.' } });
    expect(screen.getByText(/added to cool-gazelle/)).toBeTruthy();
    fireEvent.click(screen.getByTestId('managed-part-save'));
    await waitFor(() => expect(create).toHaveBeenCalledWith({ name: 'Rules', description: '', content: { kind: 'block', content: 'Use strict mode.' } }));
    expect(onCreated).toHaveBeenCalledWith(created);
  });

  it('takes MCP env as names only and says where values come from', () => {
    render(<PartDialog open kind="mcp" onClose={vi.fn()} />);
    expect(screen.getByText(/Values come from your signed-in environment/)).toBeTruthy();
  });

  it('keeps MCP arguments and variable names as typed, and parses them on save', async () => {
    const create = vi.spyOn(m(), 'createPart').mockResolvedValue({ ok: true, value: part('new', { kind: 'mcp' }) } as never);
    render(<PartDialog open kind="mcp" onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'WorkIQ' } });
    fireEvent.change(screen.getByLabelText('Server key'), { target: { value: 'workiq' } });
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'npx' } });
    const args = screen.getByLabelText('Arguments') as HTMLTextAreaElement;
    fireEvent.change(args, { target: { value: '-y\n' } });
    expect(args.value).toBe('-y\n');
    fireEvent.change(args, { target: { value: '-y\n@workiq/mcp\n\n' } });
    const env = screen.getByLabelText('Environment') as HTMLInputElement;
    fireEvent.change(env, { target: { value: 'WORKIQ_TENANT, ' } });
    expect(env.value).toBe('WORKIQ_TENANT, ');
    fireEvent.change(env, { target: { value: 'WORKIQ_TENANT, WORKIQ_REGION' } });
    fireEvent.click(screen.getByTestId('managed-part-save'));
    await waitFor(() => expect(create).toHaveBeenCalledWith({
      name: 'WorkIQ', description: '',
      content: { kind: 'mcp', serverKey: 'workiq', transport: 'stdio', command: 'npx', args: ['-y', '@workiq/mcp'], envVars: ['WORKIQ_TENANT', 'WORKIQ_REGION'] },
    }));
  });

  it('editing a shared part closes once saved and restarts the ticked agents through the restart helper', async () => {
    vi.spyOn(m(), 'getPart').mockResolvedValue({ ok: true, value: { ...part('rules', { usedBy: [consumer('ada', true), consumer('scout', true)] }), content: { kind: 'block', content: 'old' } } } as never);
    vi.spyOn(m(), 'updatePart').mockResolvedValue({ ok: true, value: part('rules', { revision: 2 }) } as never);
    vi.spyOn(m(), 'isWorking').mockImplementation(async (id: string) => ({ ok: true, value: id === 'scout' }) as never);
    const restart = vi.spyOn(m(), 'restart').mockResolvedValue({ ok: true, value: { resumed: true } } as never);
    const onClose = vi.fn();
    render(<PartDialog open kind="block" editId="rules" onClose={onClose} />);
    await waitFor(() => expect((screen.getByLabelText('Block text') as HTMLTextAreaElement).value).toBe('old'));
    fireEvent.click(screen.getByTestId('managed-part-save'));
    const dialog = await screen.findByTestId('managed-impact-dialog');
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Restart ada' }));
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Restart scout' }));
    fireEvent.click(within(dialog).getByTestId('managed-impact-save'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    await waitFor(() => expect(restart).toHaveBeenCalledWith('/p', 'ada', {}));
    await waitFor(() => expect(restart).toHaveBeenCalledWith('/p', 'scout', { whenTurnEnds: true }));
  });
});

describe('ManagedGeneralSection', () => {
  it('an unmanaged agent can switch to managed, keeping what it has, after seeing what becomes parts', async () => {
    const preview = vi.spyOn(m(), 'previewConvert').mockResolvedValue({ ok: true, value: {
      blocks: ['ada notes'], skills: ['release-notes', 'review'], mcps: ['github'],
      notes: ["The secrets MCP server isn't brought over because it holds a secret value, and Clubhouse stores no secrets."],
    } } as never);
    const convert = vi.spyOn(m(), 'convertAgent').mockResolvedValue({ ok: true, value: { version: 1, blocks: [], skills: [], mcps: [] } } as never);
    render(<ManagedGeneralSection projectPath="/p" agentId="ada" agentName="ada" setup={null} clubhouseFeatures isRunning={false} />);
    expect(screen.getByTestId('managed-general-off').textContent).toMatch(/uses the instructions, skills and MCP config in its folder/);
    fireEvent.click(screen.getByRole('button', { name: 'Switch to managed…' }));
    const dialog = await screen.findByTestId('managed-convert-dialog');
    expect((await within(dialog).findByTestId('managed-convert-summary')).textContent).toBe('Becomes: 1 block, skills release-notes, review, MCP server github.');
    expect(within(dialog).getByText(/The secrets MCP server isn't brought over/)).toBeTruthy();
    expect(preview).toHaveBeenCalledWith('/p', 'ada');
    // Nothing is written until Switch to managed.
    expect(convert).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Switch to managed' })); });
    expect(convert).toHaveBeenCalledWith('/p', 'ada', true, undefined);
  });

  it('says why the preview failed and doesn\'t switch with Keep meanwhile', async () => {
    vi.spyOn(m(), 'previewConvert').mockResolvedValue({ ok: false, code: 'invalid', message: 'This agent works in the project folder. Managed agents need their own folder.' } as never);
    render(<ManagedGeneralSection projectPath="/p" agentId="ada" agentName="ada" setup={null} clubhouseFeatures isRunning={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Switch to managed…' }));
    const dialog = await screen.findByTestId('managed-convert-dialog');
    expect((await within(dialog).findByRole('alert')).textContent).toMatch(/need their own folder/);
    expect(within(dialog).getByRole('button', { name: 'Switch to managed' })).toBeDisabled();
  });

  it('convertSummary names what becomes parts', () => {
    expect(convertSummary({ blocks: [], skills: ['a'], mcps: [] })).toBe('Becomes: skill a.');
    expect(convertSummary({ blocks: ['x', 'y'], skills: [], mcps: ['c', 'd'] })).toBe('Becomes: 2 blocks, MCP servers c, d.');
    expect(convertSummary({ blocks: [], skills: [], mcps: [] })).toBe('It has no instructions, skills or MCP servers to bring over yet.');
  });

  it('the Clubhouse features switch reports the saved value', async () => {
    const set = vi.spyOn(m(), 'setClubhouseFeatures').mockResolvedValue({ ok: true, value: undefined } as never);
    const onChange = vi.fn();
    render(<ManagedGeneralSection projectPath="/p" agentId="ada" agentName="ada" setup={null} clubhouseFeatures onClubhouseFeaturesChange={onChange} isRunning={false} />);
    await act(async () => { fireEvent.click(screen.getByRole('switch', { name: 'Clubhouse features' })); });
    expect(set).toHaveBeenCalledWith('/p', 'ada', false);
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it('a failed Clubhouse features save leaves the switch as it was', async () => {
    vi.spyOn(m(), 'setClubhouseFeatures').mockResolvedValue({ ok: false, code: 'failed', message: 'Read-only' } as never);
    const onChange = vi.fn();
    render(<ManagedGeneralSection projectPath="/p" agentId="ada" agentName="ada" setup={null} clubhouseFeatures onClubhouseFeaturesChange={onChange} isRunning={false} />);
    await act(async () => { fireEvent.click(screen.getByRole('switch', { name: 'Clubhouse features' })); });
    expect(await screen.findByRole('alert')).toHaveTextContent('Read-only');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('warns what stops working when Clubhouse features go off', () => {
    render(<ManagedGeneralSection projectPath="/p" agentId="ada" agentName="ada" setup={null} clubhouseFeatures={false} isRunning={false} />);
    expect(screen.getByTestId('managed-clubhouse-features').textContent).toMatch(/can't show this agent's status/);
  });
});

describe('focus and announcements (#2819)', () => {
  function StatefulBlocks({ initial }: { initial: string[] }) {
    const [blocks, setBlocks] = useState(initial);
    return <BlockList blocks={blocks} parts={[part('a'), part('b'), part('c')]} agent={agent} onChange={setBlocks} onFork={vi.fn()} onWrite={vi.fn()} />;
  }

  it('Remove says what was removed and moves focus to the block that took its place', async () => {
    render(<StatefulBlocks initial={['a', 'b', 'c']} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove b' }));
    expect(screen.getByRole('status').textContent).toBe('b removed.');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: /Move c/ })));
    // The last block: focus goes to the one before.
    fireEvent.click(screen.getByRole('button', { name: 'Remove c' }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: /Move a/ })));
    // None left: Write a block.
    fireEvent.click(screen.getByRole('button', { name: 'Remove a' }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('managed-write-block')));
  });

  it('Add in the library moves focus to the next block that can be added, then the search box', async () => {
    function Library() {
      const [inUse, setInUse] = useState<string[]>([]);
      return <LibraryPanel parts={[part('a'), part('b')]} inUse={inUse} onAdd={(id) => setInUse((u) => [...u, id])} onNew={vi.fn()} />;
    }
    render(<Library />);
    fireEvent.click(screen.getByRole('button', { name: 'Add a' }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add b' })));
    fireEvent.click(screen.getByRole('button', { name: 'Add b' }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Search instruction blocks' })));
  });

  it('the builder announces a block added from the library in the block list\'s live region', async () => {
    vi.spyOn(m(), 'listParts').mockImplementation(async (kind: string) => ({ ok: true, value: kind === 'block' ? [part('identity', { name: 'Identity', builtin: true })] : [] }) as never);
    function Draft() {
      const [value, setValue] = useState({ blocks: [] as string[], skills: [] as string[], mcps: [] as string[] });
      return <ManagedBuilder target={{ kind: 'draft', value, onChange: setValue, agentName: 'cool-gazelle' }} tab="instructions" />;
    }
    render(<Draft />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add Identity' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Identity added.'));
  });

  it('a part switch keeps its name, with the state in aria-checked', () => {
    const { rerender } = render(<PartToggleList kind="skill" parts={[part('notes', { kind: 'skill', name: 'Notes' })]} selected={[]} agent={agent} onToggle={vi.fn()} onFork={vi.fn()} onEdit={vi.fn()} onNew={vi.fn()} />);
    expect(screen.getByRole('switch', { name: 'Notes' }).getAttribute('aria-checked')).toBe('false');
    rerender(<PartToggleList kind="skill" parts={[part('notes', { kind: 'skill', name: 'Notes' })]} selected={['notes']} agent={agent} onToggle={vi.fn()} onFork={vi.fn()} onEdit={vi.fn()} onNew={vi.fn()} />);
    expect(screen.getByRole('switch', { name: 'Notes' }).getAttribute('aria-checked')).toBe('true');
  });

  it('each skill file\'s executable checkbox is named for its file', async () => {
    vi.spyOn(m(), 'getPart').mockResolvedValue({ ok: true, value: { ...part('deploy', { kind: 'skill' }), content: { kind: 'skill', skillName: 'deploy', files: [
      { path: 'SKILL.md', content: '# Deploy' }, { path: 'scripts/run.sh', content: 'echo', executable: true }, { path: 'scripts/check.sh', content: 'echo' },
    ] } } } as never);
    render(<PartDialog open kind="skill" editId="deploy" onClose={vi.fn()} />);
    expect(((await screen.findByRole('checkbox', { name: 'Executable: scripts/run.sh' })) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('checkbox', { name: 'Executable: scripts/check.sh' }) as HTMLInputElement).checked).toBe(false);
  });
});

describe('Preview: what the CLI reads besides the setup (#2819)', () => {
  it('lists tracked repo skills, files Claude Code is told not to read, and files it reads anyway', async () => {
    vi.spyOn(m(), 'preview').mockResolvedValue({ ok: true, value: {
      instructions: 'x', blocks: [], skills: [], mcps: [], missing: [],
      repoSkills: ['.claude/skills/repo-skill'], notRead: ['CLAUDE.md'], alsoRead: ['AGENTS.md'], cliName: 'Claude Code',
    } } as never);
    render(<PreviewPane agent={agent} />);
    expect((await screen.findByTestId('managed-preview-repo-skills')).textContent).toBe('.claude/skills/repo-skill');
    expect(screen.getByText('Also loaded from the repo')).toBeTruthy();
    expect(screen.getByTestId('managed-preview-not-read').textContent).toBe('Not read: CLAUDE.md');
    expect(screen.getByText('Also read by Claude Code')).toBeTruthy();
    expect(screen.getByTestId('managed-preview-also-read').textContent).toBe('AGENTS.md');
  });

  it('shows none of it when there is nothing outside the setup', async () => {
    vi.spyOn(m(), 'preview').mockResolvedValue({ ok: true, value: { instructions: 'x', blocks: [], skills: [], mcps: [], missing: [] } } as never);
    render(<PreviewPane agent={agent} />);
    await screen.findByTestId('managed-preview');
    expect(screen.queryByText('Also loaded from the repo')).toBeNull();
    expect(screen.queryByTestId('managed-preview-not-read')).toBeNull();
  });
});

describe('restart with nothing to resume (#2819)', () => {
  it('says it started a new conversation when one was not asked for', async () => {
    vi.spyOn(m(), 'isWorking').mockResolvedValue({ ok: true, value: false } as never);
    vi.spyOn(m(), 'restart').mockResolvedValue({ ok: true, value: { resumed: false, noSession: true } } as never);
    await requestManagedRestart({ projectPath: '/p', agentId: 'ada', agentName: 'ada' });
    expect(toasts()).toContain(`info: ${NO_SESSION_NOTE}`);
  });

  it('says nothing when a new conversation was asked for', async () => {
    vi.spyOn(m(), 'isWorking').mockResolvedValue({ ok: true, value: false } as never);
    vi.spyOn(m(), 'restart').mockResolvedValue({ ok: true, value: { resumed: false } } as never);
    await requestManagedRestart({ projectPath: '/p', agentId: 'ada', agentName: 'ada' }, { fresh: true });
    expect(toasts()).toEqual([]);
  });
});
