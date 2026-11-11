import type { ReactElement } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManagedPart, ManagedPlainPreview } from '../../../shared/managed-agents-types';
import { ImpactDialog } from './ImpactDialog';
import { ManagedGeneralSection } from './ManagedGeneralSection';
import { ManagedUiError } from './managedApi';
import { DeletePartDialog } from './PartLibraryView';
import { RestartConfirmDialog } from './restart';
import { StaleEditDialog } from './StaleEditDialog';
import { TemplatePushDialog } from './TemplatePushDialog';

const part: ManagedPart = {
  id: 'rules', kind: 'block', name: 'Rules', description: '', builtin: false,
  revision: 1, updatedAt: '', usedBy: [], templates: [], preview: '',
  content: { kind: 'block', content: 'Their rules' },
};
const ways = ['Escape', 'backdrop', 'Close', 'Cancel'];
function dismiss(dialog: HTMLElement, way: string) {
  if (way === 'Escape') fireEvent.keyDown(document, { key: 'Escape' });
  else if (way === 'backdrop') fireEvent.click(dialog.parentElement!);
  else fireEvent.click(within(dialog).getByRole('button', { name: way }));
}

beforeEach(() => vi.restoreAllMocks());

const confirmations: Array<{
  name: string;
  renderDialog: (busy: boolean, onClose: () => void, error?: string) => ReactElement;
}> = [
  {
    name: 'Impact',
    renderDialog: (busy, onCancel, error) => <ImpactDialog open partName="Rules" consumers={[]} busy={busy} onCancel={onCancel} error={error} onSave={vi.fn()} />,
  },
  {
    name: 'Template push',
    renderDialog: (busy, onCancel, error) => <TemplatePushDialog templateName="Reviewer" changes={[]} targets={[]} busy={busy} onCancel={onCancel} error={error} onSaveOnly={vi.fn()} onSaveAndApply={vi.fn()} />,
  },
  {
    name: 'Restart',
    renderDialog: (busy, onCancel) => <RestartConfirmDialog agentName="Ada" fresh={false} busy={busy} onCancel={onCancel} onNow={vi.fn()} onWhenTurnEnds={vi.fn()} />,
  },
  {
    name: 'Stale edit',
    renderDialog: (busy, onClose, error) => <StaleEditDialog theirs={part} mine={{ name: 'Rules', description: '', content: { kind: 'block', content: 'My rules' } }} busy={busy} onClose={onClose} error={error} onTakeTheirs={vi.fn()} onKeepMine={vi.fn()} onFork={vi.fn()} forkLabel="Save mine as a copy" />,
  },
];

describe.each(confirmations)('$name dismissal', ({ renderDialog }) => {
  it.each(ways)('closes via %s when not busy', (way) => {
    const onClose = vi.fn();
    render(renderDialog(false, onClose));
    dismiss(screen.getByRole('dialog'), way);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('blocks every path while busy and allows closing after the operation settles', () => {
    const onClose = vi.fn();
    const { rerender } = render(renderDialog(false, onClose));
    rerender(renderDialog(true, onClose));
    for (const way of ways) dismiss(screen.getByRole('dialog'), way);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled();
    rerender(renderDialog(false, onClose, 'Operation failed'));
    dismiss(screen.getByRole('dialog'), 'Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('Delete part dismissal', () => {
  it.each(ways)('closes via %s before deleting', (way) => {
    const onClose = vi.fn();
    render(<DeletePartDialog part={part} onClose={onClose} />);
    dismiss(screen.getByRole('dialog'), way);
    expect(onClose).toHaveBeenCalledWith(false);
  });

  it('blocks every path while deleting and keeps the eventual failure visible', async () => {
    let fail!: (reason: Error) => void;
    vi.spyOn(window.clubhouse.managed, 'deletePart').mockReturnValue(new Promise((_resolve, reject) => { fail = reject; }));
    const onClose = vi.fn();
    render(<DeletePartDialog part={part} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    for (const way of ways) dismiss(screen.getByRole('dialog'), way);
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => { fail(new ManagedUiError('failed', 'Delete failed')); });
    expect(screen.getByRole('alert')).toHaveTextContent('Delete failed');
    dismiss(screen.getByRole('dialog'), 'Cancel');
    expect(onClose).toHaveBeenCalledWith(false);
  });
});

describe('General setup dialog dismissal', () => {
  const setup = { version: 1 as const, blocks: [], skills: [], mcps: [] };
  const plain: ManagedPlainPreview = {
    instructions: { file: 'CLAUDE.md', exists: true, changedSince: false, addedLines: 0, before: null },
    mcp: null, skills: [], excludesAdded: 0, token: 'preview',
  };
  const dialogs = [
    { name: 'Convert', open: 'Switch to managed…', title: 'Switch Ada to Clubhouse managed', submit: 'Switch to managed' },
    { name: 'Save as template', open: 'Save as template…', title: 'Save as template', submit: 'Save template' },
    { name: 'Switch to plain', open: 'Switch to plain…', title: 'Switch Ada to plain', submit: 'Switch to plain' },
  ];

  const open = async (choice: typeof dialogs[number]) => {
    vi.spyOn(window.clubhouse.managed, 'previewConvert').mockResolvedValue({ ok: true, value: { blocks: [], skills: [], mcps: [], notes: [] } });
    vi.spyOn(window.clubhouse.managed, 'previewUnmanage').mockResolvedValue({ ok: true, value: plain });
    render(<ManagedGeneralSection projectPath="/p" agentId="ada" agentName="Ada" setup={choice.name === 'Convert' ? null : setup} clubhouseFeatures isRunning={false} />);
    fireEvent.click(screen.getByRole('button', { name: choice.open }));
    const dialog = screen.getByRole('dialog', { name: choice.title });
    if (choice.name === 'Convert') await within(dialog).findByTestId('managed-convert-summary');
    if (choice.name === 'Switch to plain') await within(dialog).findByTestId('managed-plain-instructions');
    return dialog;
  };

  describe.each(dialogs)('$name', (choice) => {
    it.each(ways)('closes via %s before starting an operation', async (way) => {
      const dialog = await open(choice);
      dismiss(dialog, way);
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('blocks every path during the operation and keeps its failure visible', async () => {
      let fail!: (reason: Error) => void;
      const pending = new Promise<never>((_resolve, reject) => { fail = reject; });
      const api = window.clubhouse.managed;
      if (choice.name === 'Convert') vi.spyOn(api, 'convertAgent').mockReturnValue(pending);
      else if (choice.name === 'Save as template') vi.spyOn(api, 'templateFromAgent').mockReturnValue(pending);
      else vi.spyOn(api, 'unmanage').mockReturnValue(pending);
      const dialog = await open(choice);
      fireEvent.click(within(dialog).getByRole('button', { name: choice.submit }));
      for (const way of ways) dismiss(dialog, way);
      expect(dialog).toBeVisible();
      expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
      await act(async () => { fail(new ManagedUiError('failed', 'Operation failed')); });
      expect(within(dialog).getByRole('alert')).toHaveTextContent('Operation failed');
      dismiss(dialog, 'Cancel');
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it.each(ways)('confirms dismissal of an edited template name via %s', async (way) => {
    const dialog = await open(dialogs[1]);
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'My template name' } });
    dismiss(dialog, way);
    expect(screen.getByRole('dialog', { name: 'Discard changes?' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(within(dialog).getByRole('textbox')).toHaveValue('My template name');
    dismiss(dialog, way);
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
