import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManagedPartConsumer, ManagedPartSummary } from '../../../shared/managed-agents-types';
import { BlockList } from './BlockList';
import { PartToggleList } from './LibraryPanel';
import { ImpactDialog } from './ImpactDialog';
import { ManagedBuilder } from './ManagedBuilder';
import { PartDialog } from './PartDialog';
import { ManagedGeneralSection } from './ManagedGeneralSection';

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
});

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
    expect(within(builtin).queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(within(builtin).getByRole('button', { name: 'Make your copy' })).toBeTruthy();
    expect(shared.textContent).toContain('Custom · 3 agents');
    expect(mine.textContent).toContain('release-lead only');
  });

  it('editing a shared block says so, and saving asks who it reaches first', async () => {
    vi.spyOn(m(), 'getPart').mockResolvedValue({ ok: true, value: { ...part('shared'), content: { kind: 'block', content: 'old' } } } as never);
    const update = vi.spyOn(m(), 'updatePart').mockResolvedValue({ ok: true, value: part('shared', { revision: 2 }) } as never);
    const restart = vi.spyOn(m(), 'restart');
    render(<BlockList blocks={['shared']} parts={[part('shared', { usedBy: [consumer('release-lead', true), consumer('ada')] })]} agent={agent} onChange={vi.fn()} onFork={vi.fn()} onWrite={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const text = await screen.findByRole('textbox');
    expect(screen.getByText(/You're editing shared for 2 agents/)).toBeTruthy();
    expect(screen.getByTestId('managed-wildcards')).toBeTruthy();
    fireEvent.change(text, { target: { value: 'new' } });
    fireEvent.click(screen.getByTestId('managed-block-save'));
    const dialog = await screen.findByTestId('managed-impact-dialog');
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Restart release-lead now' }));
    fireEvent.click(within(dialog).getByTestId('managed-impact-save'));
    await waitFor(() => expect(update).toHaveBeenCalledWith({ id: 'shared', expectedRevision: 1, content: { kind: 'block', content: 'new' } }));
    await waitFor(() => expect(restart).toHaveBeenCalledWith('/p', 'release-lead'));
  });

  it('fork instead keeps the edit on the copy and leaves the shared block alone', async () => {
    vi.spyOn(m(), 'getPart').mockImplementation(async (id: string) => ({ ok: true, value: { ...part(id), content: { kind: 'block', content: 'old' } } }) as never);
    const update = vi.spyOn(m(), 'updatePart').mockResolvedValue({ ok: true, value: part('copy') } as never);
    const onFork = vi.fn(async () => 'copy');
    render(<BlockList blocks={['shared']} parts={[part('shared', { usedBy: [consumer('release-lead'), consumer('ada')] })]} agent={agent} onChange={vi.fn()} onFork={onFork} onWrite={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
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
    fireEvent.click(screen.getByRole('switch', { name: 'Add Notes' }));
    expect(onToggle).toHaveBeenCalledWith('notes', true);
  });
});

describe('ImpactDialog', () => {
  it('offers restart only for running agents and says restart resumes', () => {
    render(<ImpactDialog open partName="Rules" consumers={[consumer('a', true), consumer('b')]} onSave={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
    expect(screen.getByText(/resumes the same conversation/)).toBeTruthy();
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
    fireEvent.click(await screen.findByRole('switch', { name: 'Add Notes' }));
    await waitFor(() => expect(save).toHaveBeenCalledWith('/p', 'release-lead', { blocks: [], skills: ['notes'], mcps: [] }));
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
});

describe('ManagedGeneralSection', () => {
  it('an unmanaged agent can switch to managed, keeping what it has', async () => {
    const convert = vi.spyOn(m(), 'convertAgent').mockResolvedValue({ ok: true, value: { version: 1, blocks: [], skills: [], mcps: [] } } as never);
    render(<ManagedGeneralSection projectPath="/p" agentId="ada" agentName="ada" setup={null} clubhouseFeatures isRunning={false} />);
    expect(screen.getByTestId('managed-general-off').textContent).toMatch(/uses the instructions, skills and MCP config in its folder/);
    fireEvent.click(screen.getByRole('button', { name: 'Switch to managed…' }));
    const dialog = await screen.findByTestId('managed-convert-dialog');
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Switch to managed' })); });
    expect(convert).toHaveBeenCalledWith('/p', 'ada', true, undefined);
  });

  it('warns what stops working when Clubhouse features go off', () => {
    render(<ManagedGeneralSection projectPath="/p" agentId="ada" agentName="ada" setup={null} clubhouseFeatures={false} isRunning={false} />);
    expect(screen.getByTestId('managed-clubhouse-features').textContent).toMatch(/can't show this agent's status/);
  });
});
