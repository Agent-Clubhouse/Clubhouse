import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManagedPart, ManagedPartConsumer, ManagedPartContent, ManagedPartSummary } from '../../../shared/managed-agents-types';
import { BlockList } from './BlockList';
import { ImpactDialog, impactTitle, needsImpactDialog } from './ImpactDialog';
import { PartDialog } from './PartDialog';
import { TemplatesSettingsView } from './TemplatesSettingsView';
import { builtFromLine, changedLine } from './attribution';
import { lineDiff, partAsText } from './stale-edit';
import { leftAloneNotice, resetPendingRestarts } from './restart';
import { useToastStore } from '../../stores/toastStore';
import { ManagedUiError } from './managedApi';

/** Shared part edits (#2897): templates in the save dialog, the toast after it, and stale edits. */

const consumer = (agentId: string, running = false): ManagedPartConsumer => ({
  projectPath: '/p', projectName: 'Clubhouse', agentId, agentName: agentId, color: 'indigo', running,
});

function part(id: string, over: Partial<ManagedPartSummary> = {}): ManagedPartSummary {
  return { id, kind: 'block', name: id, description: '', builtin: false, revision: 1, updatedAt: '', usedBy: [], templates: [], preview: '', ...over };
}

function full(id: string, text: string, over: Partial<ManagedPartSummary> = {}): ManagedPart {
  return { ...part(id, over), content: { kind: 'block', content: text } };
}

const agent = { projectPath: '/p', agentId: 'release-lead', agentName: 'release-lead' };
const m = () => window.clubhouse.managed;
const toasts = () => useToastStore.getState().toasts.map((t) => t.message);
const STALE = { ok: false, code: 'stale', message: 'It changed since you opened it.' } as never;

beforeEach(() => {
  vi.restoreAllMocks();
  resetPendingRestarts();
  useToastStore.setState({ toasts: [] });
});

describe('the save dialog lists templates too', () => {
  it('titles agents and templates, and asks when anything besides one agent uses the part', () => {
    expect(impactTitle('Rules', 3, 0)).toBe('Save Rules for 3 agents?');
    expect(impactTitle('Rules', 1, 2)).toBe('Save Rules for 1 agent and 2 templates?');
    expect(impactTitle('Rules', 0, 2)).toBe('Save Rules for 2 templates?');
    expect(needsImpactDialog({ usedBy: [1], templates: [] })).toBe(false);
    expect(needsImpactDialog({ usedBy: [1], templates: [1] })).toBe(true);
    expect(needsImpactDialog({ usedBy: [], templates: [1, 2] })).toBe(true);
    expect(needsImpactDialog({ usedBy: [1], templates: [] }, 1)).toBe(true);
  });

  it('lists each template that uses the part', () => {
    render(<ImpactDialog open partName="Rules" consumers={[consumer('ada')]} templates={[{ id: 't1', name: 'Reviewer' }, { id: 't2', name: 'Release' }]} onSave={vi.fn()} onCancel={vi.fn()} />);
    const dialog = screen.getByTestId('managed-impact-dialog');
    expect(within(dialog).getByText('Save Rules for 1 agent and 2 templates?')).toBeTruthy();
    expect(within(dialog).getByTestId('managed-impact-templates').textContent).toBe('ReviewerRelease');
    expect(dialog.textContent).toContain('Agents made from them later get the new version too.');
  });

  it('shows the dialog for a block one agent and one template use', async () => {
    vi.spyOn(m(), 'getPart').mockResolvedValue({ ok: true, value: full('rules', 'old') } as never);
    render(<BlockList blocks={['rules']} parts={[part('rules', { usedBy: [consumer('release-lead')], templates: [{ id: 't1', name: 'Reviewer' }] })]} agent={agent} onChange={vi.fn()} onFork={vi.fn()} onWrite={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit rules' }));
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: 'new' } });
    fireEvent.click(screen.getByTestId('managed-block-save'));
    const dialog = await screen.findByTestId('managed-impact-dialog');
    expect(within(dialog).getByTestId('managed-impact-templates').textContent).toBe('Reviewer');
  });
});

describe('the toast after a save', () => {
  it('counts running agents that weren\'t restarted', () => {
    const users = [consumer('a', true), consumer('b', true), consumer('c')];
    expect(leftAloneNotice(users, [])).toBe('Saved. 2 running agents will use it after a restart.');
    expect(leftAloneNotice(users, [{ agentId: 'a' }])).toBe('Saved. 1 running agent will use it after a restart.');
    expect(leftAloneNotice(users, [{ agentId: 'a' }, { agentId: 'b' }])).toBeNull();
  });

  it('shows after saving from the dialog with running agents left alone', async () => {
    const users = [consumer('release-lead', true), consumer('ada', true), consumer('scout')];
    vi.spyOn(m(), 'getPart').mockResolvedValue({ ok: true, value: full('shared', 'old') } as never);
    vi.spyOn(m(), 'updatePart').mockResolvedValue({ ok: true, value: part('shared', { revision: 2, usedBy: users }) } as never);
    render(<BlockList blocks={['shared']} parts={[part('shared', { usedBy: users })]} agent={agent} onChange={vi.fn()} onFork={vi.fn()} onWrite={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit shared' }));
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: 'new' } });
    fireEvent.click(screen.getByTestId('managed-block-save'));
    fireEvent.click(within(await screen.findByTestId('managed-impact-dialog')).getByTestId('managed-impact-save'));
    await waitFor(() => expect(toasts()).toContain('Saved. 2 running agents will use it after a restart.'));
  });
});

describe('a stale edit', () => {
  const theirs = full('rules', 'line one\ntheir line', { revision: 3, updatedBy: 'Dispatcher', updatedAt: new Date(Date.now() - 2 * 60_000).toISOString(), usedBy: [consumer('release-lead')] });

  const openAndSave = async (onFork = vi.fn(async () => 'rules-copy')) => {
    vi.spyOn(m(), 'getPart')
      .mockResolvedValueOnce({ ok: true, value: full('rules', 'line one') } as never)
      .mockResolvedValue({ ok: true, value: theirs } as never);
    const update = vi.spyOn(m(), 'updatePart')
      .mockResolvedValueOnce(STALE)
      .mockResolvedValue({ ok: true, value: part('rules', { revision: 4, usedBy: [consumer('release-lead')] }) } as never);
    render(<BlockList blocks={['rules']} parts={[part('rules', { usedBy: [consumer('release-lead')] })]} agent={agent} onChange={vi.fn()} onFork={onFork} onWrite={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit rules' }));
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: 'line one\nmy line' } });
    fireEvent.click(screen.getByTestId('managed-block-save'));
    const dialog = await screen.findByTestId('managed-stale-dialog');
    return { dialog, update, onFork };
  };

  it('shows who changed it and both versions, and saves nothing yet', async () => {
    const { dialog, update } = await openAndSave();
    expect(within(dialog).getByText('rules changed since you opened it.')).toBeTruthy();
    expect(within(dialog).getByTestId('managed-stale-by').textContent).toBe('Changed by Dispatcher, 2m ago.');
    const lines = [...within(dialog).getByTestId('managed-stale-diff').children].map((el) => `${el.getAttribute('data-kind')}:${el.textContent}`);
    expect(lines).toContain('theirs:- their line');
    expect(lines).toContain('yours:+ my line');
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('Keep mine saves over their version, pinned to their revision', async () => {
    const { dialog, update } = await openAndSave();
    fireEvent.click(within(dialog).getByTestId('managed-stale-mine'));
    await waitFor(() => expect(update).toHaveBeenLastCalledWith({ id: 'rules', expectedRevision: 3, content: { kind: 'block', content: 'line one\nmy line' } }));
    await waitFor(() => expect(screen.queryByTestId('managed-stale-dialog')).toBeNull());
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('Take theirs drops the edit without saving', async () => {
    const { dialog, update } = await openAndSave();
    fireEvent.click(within(dialog).getByTestId('managed-stale-theirs'));
    expect(screen.queryByTestId('managed-stale-dialog')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(update).toHaveBeenCalledTimes(1);
  });

  it.each(['Escape', 'backdrop', 'Close', 'Cancel'])('%s returns to the block edit without taking theirs', async (way) => {
    const user = userEvent.setup();
    const { dialog, update } = await openAndSave();
    if (way === 'Escape') await user.keyboard('{Escape}');
    else if (way === 'backdrop') fireEvent.click(dialog.parentElement!);
    else fireEvent.click(within(dialog).getByRole('button', { name: way }));
    await waitFor(() => expect(screen.queryByTestId('managed-stale-dialog')).toBeNull());
    expect(screen.getByRole('textbox')).toHaveValue('line one\nmy line');
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('Close returns to the part editor with its dirty draft intact', async () => {
    const user = userEvent.setup();
    vi.spyOn(m(), 'getPart')
      .mockResolvedValueOnce({ ok: true, value: full('rules', 'old') })
      .mockResolvedValue({ ok: true, value: theirs });
    const update = vi.spyOn(m(), 'updatePart').mockResolvedValueOnce(STALE);
    const onClose = vi.fn();
    render(<PartDialog open kind="block" editId="rules" onClose={onClose} />);
    await waitFor(() => expect(screen.getByLabelText('Block text')).toHaveValue('old'));
    fireEvent.change(screen.getByLabelText('Block text'), { target: { value: 'my edit' } });
    fireEvent.click(screen.getByTestId('managed-part-save'));
    const dialog = await screen.findByTestId('managed-stale-dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByTestId('managed-stale-dialog')).toBeNull());
    expect(screen.getByLabelText('Block text')).toHaveValue('my edit');
    expect(onClose).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
    await user.keyboard('{Escape}');
    expect(await screen.findByRole('dialog', { name: 'Discard changes?' })).toBeTruthy();
  });

  it('Fork puts the edit on a copy for this agent', async () => {
    const { dialog, onFork } = await openAndSave();
    expect(within(dialog).getByTestId('managed-stale-fork').textContent).toBe('Fork for release-lead');
    fireEvent.click(within(dialog).getByTestId('managed-stale-fork'));
    await waitFor(() => expect(onFork).toHaveBeenCalled());
  });

  describe('part editor dismissal', () => {
    const contents: ManagedPartContent[] = [
      { kind: 'block', content: 'Original instructions' },
      { kind: 'skill', skillName: 'review', files: [{ path: 'SKILL.md', content: 'Review changes' }] },
      { kind: 'mcp', serverKey: 'github', transport: 'stdio', command: 'npx', args: ['github'], envVars: ['TOKEN'] },
    ];
    const ways = ['Escape', 'backdrop', 'Close', 'Cancel'];
    const dismiss = async (way: string) => {
      const dialog = screen.getByTestId('managed-part-dialog');
      if (way === 'Escape') await userEvent.setup().keyboard('{Escape}');
      else if (way === 'backdrop') fireEvent.click(dialog.parentElement!);
      else fireEvent.click(within(dialog).getByRole('button', { name: way }));
    };

    describe.each(contents)('$kind', (content) => {
      const open = async () => {
        vi.spyOn(m(), 'getPart').mockResolvedValue({ ok: true, value: { ...part('rules', { kind: content.kind }), content } });
        const onClose = vi.fn();
        render(<PartDialog open kind={content.kind} editId="rules" onClose={onClose} />);
        await waitFor(() => expect(screen.getByLabelText('Name')).toHaveValue('rules'));
        return onClose;
      };

      it.each(ways)('closes via %s before editing', async (way) => {
        const onClose = await open();
        await dismiss(way);
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(screen.queryByRole('dialog', { name: 'Discard changes?' })).toBeNull();
      });

      it.each(ways)('confirms dirty dismissal via %s and preserves work when declined', async (way) => {
        const onClose = await open();
        const label = content.kind === 'block' ? 'Block text' : content.kind === 'skill' ? 'SKILL.md' : 'Arguments';
        fireEvent.change(screen.getByLabelText(label), { target: { value: 'My unsaved edit\n' } });
        await dismiss(way);
        expect(onClose).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
        expect(screen.getByLabelText(label)).toHaveValue('My unsaved edit\n');
        await dismiss(way);
        fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
        expect(onClose).toHaveBeenCalledTimes(1);
      });

      it('blocks every way out while saving and keeps the eventual error and draft visible', async () => {
        const onClose = await open();
        let fail!: (reason: Error) => void;
        const update = vi.spyOn(m(), 'updatePart').mockReturnValue(new Promise((_resolve, reject) => { fail = reject; }));
        fireEvent.change(screen.getByTestId('managed-part-description'), { target: { value: 'My description' } });
        fireEvent.click(screen.getByTestId('managed-part-save'));
        for (const way of ways) await dismiss(way);
        expect(update).toHaveBeenCalledTimes(1);
        expect(onClose).not.toHaveBeenCalled();
        expect(screen.queryByRole('dialog', { name: 'Discard changes?' })).toBeNull();
        await act(async () => { fail(new ManagedUiError('failed', 'Save failed')); });
        expect(screen.getByRole('alert')).toHaveTextContent('Save failed');
        expect(screen.getByTestId('managed-part-description')).toHaveValue('My description');
        await dismiss('Cancel');
        expect(screen.getByRole('dialog', { name: 'Discard changes?' })).toBeTruthy();
      });

      it('treats a reverted edit as pristine', async () => {
        const onClose = await open();
        fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Changed' } });
        fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'rules' } });
        await dismiss('Escape');
        expect(onClose).toHaveBeenCalledTimes(1);
      });
    });

    it('treats a reverted executable checkbox as pristine when the flag was omitted', async () => {
      vi.spyOn(m(), 'getPart').mockResolvedValue({
        ok: true,
        value: {
          ...part('review', { kind: 'skill' }),
          content: { kind: 'skill', skillName: 'review', files: [{ path: 'SKILL.md', content: 'Review' }, { path: 'check.sh', content: 'echo check' }] },
        },
      });
      const onClose = vi.fn();
      render(<PartDialog open kind="skill" editId="review" onClose={onClose} />);
      await waitFor(() => expect(screen.getByLabelText('Name')).toHaveValue('review'));
      const executable = screen.getByRole('checkbox', { name: 'Executable: check.sh' });
      fireEvent.click(executable);
      fireEvent.click(executable);
      await dismiss('Escape');
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('treats a cleared optional MCP field as pristine after reverting the transport', async () => {
      const onClose = vi.fn();
      render(<PartDialog open kind="mcp" onClose={onClose} />);
      fireEvent.change(screen.getByLabelText('Transport'), { target: { value: 'http' } });
      fireEvent.change(screen.getByLabelText('URL'), { target: { value: 'https://example.com' } });
      fireEvent.change(screen.getByLabelText('URL'), { target: { value: '' } });
      fireEvent.change(screen.getByLabelText('Transport'), { target: { value: 'stdio' } });
      await dismiss('Escape');
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  it('in the part dialog, saves mine as a library copy and leaves the shared part alone', async () => {
    vi.spyOn(m(), 'getPart')
      .mockResolvedValueOnce({ ok: true, value: full('rules', 'mine?', { name: 'Rules' }) } as never)
      .mockResolvedValue({ ok: true, value: { ...theirs, name: 'Rules' } } as never);
    const update = vi.spyOn(m(), 'updatePart')
      .mockResolvedValueOnce(STALE)
      .mockResolvedValue({ ok: true, value: part('rules-copy', { revision: 2 }) } as never);
    const fork = vi.spyOn(m(), 'forkPart').mockResolvedValue({ ok: true, value: part('rules-copy', { name: 'Rules copy' }) } as never);
    const onClose = vi.fn();
    render(<PartDialog open kind="block" editId="rules" onClose={onClose} />);
    const text = await screen.findByRole('textbox', { name: 'Block text' });
    await waitFor(() => expect((text as HTMLTextAreaElement).value).toBe('mine?'));
    fireEvent.change(text, { target: { value: 'mine!' } });
    fireEvent.click(screen.getByTestId('managed-part-save'));
    const dialog = await screen.findByTestId('managed-stale-dialog');
    fireEvent.click(within(dialog).getByTestId('managed-stale-fork'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(fork).toHaveBeenCalledWith('rules');
    expect(update).toHaveBeenLastCalledWith({ id: 'rules-copy', expectedRevision: 1, expectedDescription: '', description: '', content: { kind: 'block', content: 'mine!' } });
  });

  it('in the part dialog, sends the name and description it opened, and Keep mine pins their rename', async () => {
    vi.spyOn(m(), 'getPart')
      .mockResolvedValueOnce({ ok: true, value: full('rules', 'text', { name: 'Rules', description: 'Old' }) } as never)
      .mockResolvedValue({ ok: true, value: full('rules', 'text', { name: 'House rules', description: 'New', revision: 1, updatedBy: 'Dispatcher' }) } as never);
    const update = vi.spyOn(m(), 'updatePart')
      .mockResolvedValueOnce(STALE)
      .mockResolvedValue({ ok: true, value: part('rules', { revision: 2 }) } as never);
    render(<PartDialog open kind="block" editId="rules" onClose={vi.fn()} />);
    const text = await screen.findByRole('textbox', { name: 'Block text' });
    await waitFor(() => expect((text as HTMLTextAreaElement).value).toBe('text'));
    fireEvent.change(text, { target: { value: 'my text' } });
    fireEvent.click(screen.getByTestId('managed-part-save'));
    const dialog = await screen.findByTestId('managed-stale-dialog');
    expect(update).toHaveBeenNthCalledWith(1, expect.objectContaining({ expectedRevision: 1, expectedName: 'Rules', expectedDescription: 'Old', name: 'Rules' }));
    // Their rename shows in the diff before anything is saved.
    const lines = [...within(dialog).getByTestId('managed-stale-diff').children].map((el) => el.textContent);
    expect(lines).toContain('- Name: House rules');
    expect(lines).toContain('+ Name: Rules');
    fireEvent.click(within(dialog).getByTestId('managed-stale-mine'));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ expectedRevision: 1, expectedName: 'House rules', expectedDescription: 'New', name: 'Rules', description: 'Old' }));
  });
});

describe('the diff', () => {
  it('marks lines only in theirs and only in yours, keeping shared ones', () => {
    expect(lineDiff('a\nb\nc', 'a\nx\nc')).toEqual([
      { kind: 'same', text: 'a' }, { kind: 'theirs', text: 'b' }, { kind: 'yours', text: 'x' }, { kind: 'same', text: 'c' },
    ]);
    expect(lineDiff('same', 'same')).toEqual([{ kind: 'same', text: 'same' }]);
  });

  it('shows a part\'s name, files and MCP fields as lines, never env values', () => {
    expect(partAsText({ name: 'S', description: '', content: { kind: 'skill', skillName: 's', files: [{ path: 'run.sh', content: 'echo', executable: true }, { path: 'SKILL.md', content: 'Do it' }] } }))
      .toBe('Name: S\nFolder: s\n\nFile: SKILL.md\nDo it\n\nFile: run.sh (executable)\necho');
    const mcp = partAsText({ name: 'W', description: 'd', content: { kind: 'mcp', serverKey: 'w', transport: 'stdio', command: 'npx', args: ['w'], envVars: ['TOKEN_NAME'], env: { SECRET: 'value' } } });
    expect(mcp).toContain('Environment: TOKEN_NAME');
    expect(mcp).not.toContain('value');
  });

  it('says who changed it and when', () => {
    const now = Date.parse('2026-11-07T12:00:00Z');
    expect(changedLine('2026-11-07T11:58:00Z', 'Dispatcher', now)).toBe('Changed by Dispatcher, 2m ago.');
    expect(changedLine('2026-11-07T11:58:00Z', undefined, now)).toBe('Changed 2m ago.');
  });

  it('says what a helper was built from', () => {
    const names: Record<string, string> = { pw: 'Playwright', cr: 'code-review', lint: 'Lint' };
    expect(builtFromLine('Helper', { added: ['pw'], removed: ['cr'] }, (id) => names[id])).toBe('Helper template, plus Playwright, minus code-review');
    expect(builtFromLine('Helper', { added: ['pw', 'lint'], removed: [] }, (id) => names[id])).toBe('Helper template, plus Playwright, Lint');
    expect(builtFromLine(null, { added: [], removed: ['gone'] }, (id) => names[id])).toBe('Its template, minus a part no longer in the library');
  });
});

describe('template attribution (#2900)', () => {
  it('says the Dispatcher changed a template in the list', async () => {
    vi.spyOn(m(), 'listTemplates').mockResolvedValue({ ok: true, value: [
      { id: 't1', name: 'Reviewer', description: '', builtin: false, setup: { blocks: [], skills: [], mcps: [] }, settings: {}, usedBy: 0, updatedBy: 'Dispatcher', updatedAt: new Date(Date.now() - 5 * 60_000).toISOString() },
      { id: 't2', name: 'Mine', description: '', builtin: false, setup: { blocks: [], skills: [], mcps: [] }, settings: {}, usedBy: 0 },
    ] } as never);
    render(<TemplatesSettingsView />);
    const changed = await screen.findAllByTestId('managed-template-changed');
    expect(changed.map((el) => el.textContent)).toEqual(['Changed by Dispatcher, 5m ago.']);
  });
});
