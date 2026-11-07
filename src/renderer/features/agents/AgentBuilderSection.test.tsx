import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { AgentBuilderSection } from './AgentBuilderSection';
import type { BuilderBlock, BuilderCommand, BuilderResult, BuilderView } from '../../../shared/agent-builder-types';
import { composeInstructions } from '../../../main/services/asset-catalog/composer';

const api = window.clubhouse.agentSettings;
const identity: BuilderBlock = { key: 'base:identity', entry: { baseEntryId: 'identity', source: { kind: 'follow' } }, assetId: 'identity', revision: 1, name: 'Identity', content: 'You are @@AgentName.', source: 'Inherited from template', editable: false };
const role: BuilderBlock = { ...identity, key: 'base:role', entry: { baseEntryId: 'role', source: { kind: 'follow' } }, assetId: 'role', name: 'Researcher role', content: 'Find the evidence.' };
let saved: BuilderView;
let requests: BuilderCommand[];
const renderBuilder = () => render(<AgentBuilderSection projectId="project-1" projectPath="/project" agentId="agent-1" />);
const rows = () => screen.getAllByTestId('builder-block');
const settle = () => waitFor(() => expect(screen.queryByText('Saving in Builder…')).not.toBeInTheDocument());
beforeEach(() => {
  saved = { revision: 1, templateId: 'builtin-builder-researcher', templates: [{ id: 'builtin-builder-researcher', name: 'Researcher' }, { id: 'builtin-builder-custom', name: 'Custom' }], blocks: structuredClone([identity, role]), customOrder: false, text: 'You are @@AgentName.\n\nFind the evidence.' };
  requests = [];
  api.builderRead = vi.fn(async () => ({ ok: true, view: structuredClone(saved) }));
  api.builderPreview = vi.fn(async (contents) => composeInstructions(contents.map((content) => ({ content }))));
  api.builderCommand = vi.fn(async (_project, _agent, _revision, command): Promise<BuilderResult> => {
    requests.push(command);
    if (command.type === 'template' && !command.confirm) return { ok: true, view: { ...saved, blocks: [identity], templateId: command.templateId } };
    if (command.type === 'template') { saved.blocks = [identity]; saved.templateId = command.templateId; }
    else if (command.type === 'order') { saved.blocks = command.keys.map((k) => saved.blocks.find((b) => b.key === k)!); saved.customOrder = true; }
    else if (command.type === 'baseOrder') { saved.blocks = [identity, role]; saved.customOrder = false; }
    else if (command.type === 'append') saved.blocks.push({ ...identity, key: 'local:notes', name: command.name, content: command.content, source: "This agent's", editable: true, entry: { localId: 'notes', source: { kind: 'local', blockId: 'notes' } } });
    else if (command.type === 'fork') saved.blocks = saved.blocks.map((b) => b.key === command.key ? { ...b, source: `Fork of ${b.name} at revision 1`, editable: true, entry: { baseEntryId: b.entry.baseEntryId, source: { kind: 'fork', blockId: 'fork', forkedFrom: { assetId: b.assetId, revision: 1 } } } } : b);
    else if (command.type === 'return') saved.blocks = saved.blocks.map((b) => b.key === command.key ? structuredClone(identity) : b);
    else if (command.type === 'remove') saved.blocks = saved.blocks.filter((b) => b.key !== command.key);
    else if (command.type === 'edit') saved.blocks = saved.blocks.map((b) => b.key === command.key ? { ...b, content: command.content } : b);
    saved.revision++;
    const composed = composeInstructions(saved.blocks);
    saved.text = composed.ok ? composed.text : '';
    return { ok: true, view: structuredClone(saved) };
  });
});
it('shows the permanent saved-only notice, names sources and shows exact composer text with boundaries beside it', async () => {
  renderBuilder();
  expect(screen.getByText("Builder edits are saved only. Review a separate snapshot below for next-start adoption.")).toBeVisible();
  await screen.findByText('1. Identity');
  await waitFor(() => expect(screen.getByTestId('builder-effective-preview').textContent).toBe(saved.text));
  expect(within(screen.getByRole('list', { name: 'Preview block boundaries' })).getByText(/Lines 1 to 1/)).toBeVisible();
  expect(api.builderPreview).toHaveBeenCalledWith(['You are @@AgentName.', 'Find the evidence.']);
  expect(within(rows()[0]).getByText('Inherited from template')).toBeVisible();
});
it('previews template replacement before confirming; cancel keeps the saved list', async () => {
  renderBuilder();
  await screen.findByText('1. Identity');
  fireEvent.change(screen.getByLabelText('Choose a template'), { target: { value: 'builtin-builder-custom' } });
  await screen.findByText(/This replaces the saved block list/);
  expect(rows()).toHaveLength(1);
  expect(saved.blocks).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel', exact: true }));
  expect(rows()).toHaveLength(2);
  fireEvent.change(screen.getByLabelText('Choose a template'), { target: { value: 'builtin-builder-custom' } });
  fireEvent.click(await screen.findByRole('button', { name: 'Save template' }));
  await settle();
  expect(saved.templateId).toBe('builtin-builder-custom');
  expect(requests.at(-1)).toEqual({ type: 'template', templateId: 'builtin-builder-custom', confirm: true, binding: undefined });
});
it('reorders with move buttons, keyboard arrows and drag; offers base order', async () => {
  renderBuilder();
  await screen.findByText('1. Identity');
  expect(screen.getByRole('button', { name: 'Move Identity up' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Move Identity down' }));
  await settle();
  expect(within(rows()[0]).getByText('1. Researcher role')).toBeVisible();
  fireEvent.keyDown(screen.getByRole('button', { name: 'Reorder Identity' }), { key: 'ArrowUp' });
  await settle();
  expect(within(rows()[0]).getByText('1. Identity')).toBeVisible();
  const dataTransfer = { setData: vi.fn(), effectAllowed: '' };
  fireEvent.dragStart(screen.getByRole('button', { name: 'Reorder Identity' }), { dataTransfer });
  fireEvent.dragOver(rows()[1]);
  fireEvent.drop(rows()[1]);
  await settle();
  expect(within(rows()[0]).getByText('1. Researcher role')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Use base order' }));
  await settle();
  expect(screen.getByText('Template order')).toBeVisible();
});
it('appends, edits, persists across a remount, then removes an agent-owned block', async () => {
  const rendered = renderBuilder();
  await screen.findByText('1. Identity');
  fireEvent.change(screen.getByLabelText('Block name'), { target: { value: 'Notes' } });
  fireEvent.change(screen.getByLabelText('Block text'), { target: { value: 'Keep @@Path.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add block' }));
  await settle();
  expect(within(rows()[2]).getByText("This agent's")).toBeVisible();
  fireEvent.change(screen.getByLabelText('Notes text'), { target: { value: 'Edited @@Path.' } });
  await waitFor(() => expect(screen.getByTestId('builder-effective-preview')).toHaveTextContent('Edited @@Path.'));
  fireEvent.click(screen.getByRole('button', { name: 'Save block' }));
  await settle();
  rendered.unmount();
  renderBuilder();
  expect(await screen.findByLabelText('Notes text')).toHaveValue('Edited @@Path.');
  fireEvent.click(screen.getByRole('button', { name: 'Remove block' }));
  await settle();
  expect(rows()).toHaveLength(2);
});
it('forks, edits wildcard source text and returns to template', async () => {
  renderBuilder();
  await screen.findByText('1. Identity');
  fireEvent.click(within(rows()[0]).getByRole('button', { name: 'Fork block' }));
  await settle();
  expect(screen.getByLabelText('Identity text')).toHaveValue('You are @@AgentName.');
  expect(within(rows()[0]).getByText('Fork of Identity at revision 1')).toBeVisible();
  fireEvent.change(screen.getByLabelText('Identity text'), { target: { value: 'Forked @@AgentName.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save block' }));
  await settle();
  fireEvent.click(screen.getByRole('button', { name: 'Return to template' }));
  await settle();
  expect(screen.queryByLabelText('Identity text')).not.toBeInTheDocument();
  expect(identity.content).toBe('You are @@AgentName.');
});
it.each(['stale', 'failed'] as const)('reverts an optimistic order on %s and reloads visibly', async (code) => {
  renderBuilder();
  await screen.findByText('1. Identity');
  let resolve!: (result: BuilderResult) => void;
  vi.mocked(api.builderCommand).mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
  fireEvent.click(screen.getByRole('button', { name: 'Move Identity down' }));
  expect(within(rows()[0]).getByText('1. Researcher role')).toBeVisible();
  await act(async () => resolve({ ok: false, code }));
  await settle();
  expect(within(rows()[0]).getByText('1. Identity')).toBeVisible();
  expect(screen.getByRole('alert')).toHaveTextContent(code === 'stale' ? 'Reloaded the latest version' : 'reverted');
  expect(api.builderRead).toHaveBeenCalledTimes(2);
});
it('failed edit reverts the textarea and preview, and transport errors show a retry path', async () => {
  saved.blocks[0] = { ...identity, editable: true, source: "This agent's" };
  renderBuilder();
  await screen.findByLabelText('Identity text');
  fireEvent.change(screen.getByLabelText('Identity text'), { target: { value: 'unsaved private text' } });
  vi.mocked(api.builderCommand).mockResolvedValueOnce({ ok: false, code: 'failed' });
  fireEvent.click(screen.getByRole('button', { name: 'Save block' }));
  await settle();
  expect(screen.getByLabelText('Identity text')).toHaveValue(identity.content);
  await waitFor(() => expect(screen.getByTestId('builder-effective-preview').textContent).toBe(saved.text));
  vi.mocked(api.builderCommand).mockRejectedValueOnce(new Error('private content'));
  fireEvent.click(screen.getByRole('button', { name: 'Move Identity down' }));
  await settle();
  expect(screen.getByRole('alert')).toHaveTextContent('Try Reload');
  expect(screen.getByRole('alert')).not.toHaveTextContent('private content');
});

it('shows raised defaults and requires explicit agreement before saving a template', async () => {
  renderBuilder();
  await screen.findByText('1. Identity');
  vi.mocked(api.builderCommand).mockResolvedValueOnce({ ok: true, view: {
    ...saved, templateId: 'builtin-builder-custom', blocks: [identity], operationalIncreases: [
      { key: 'agentAccess', value: 'bypass' }, { key: 'orchestrate', value: true }, { key: 'maxHelpers', value: 10 },
    ],
  } });
  fireEvent.change(screen.getByLabelText('Choose a template'), { target: { value: 'builtin-builder-custom' } });
  const increases = await screen.findByRole('list', { name: 'Operational increases' });
  expect(increases).toHaveTextContent('Agent access: Skip permission prompts');
  expect(increases).toHaveTextContent('Start helpers: On');
  expect(increases).toHaveTextContent('Helper limit: 10');
  expect(screen.getByRole('button', { name: 'Save template' })).toBeDisabled();
  expect(screen.getByText(/raises these saved operational defaults/)).toHaveTextContent("They aren't used by this agent yet.");
  fireEvent.click(screen.getByRole('checkbox', { name: 'I agree to save these increases in Builder' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save template' }));
  await settle();
  expect(requests[requests.length - 1]).toMatchObject({ type: 'template', confirm: true, acknowledgeOperationalIncreases: true });
});

it('shows explicit unsupported composition refusal without a successful snapshot or skill workflow', async () => {
  api.builderRead = vi.fn(async () => ({ ok: false, code: 'unsupported' }));
  renderBuilder();
  expect(await screen.findByText('This composition contains MCP or native subagent references. Builder cannot preview or save it. Nothing was changed or loaded.')).toBeVisible();
  expect(screen.queryByRole('region', { name: 'Builder skills' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Save skill references' })).not.toBeInTheDocument();
  expect(api.builderCommand).not.toHaveBeenCalled();
  expect(api.builderPreview).not.toHaveBeenCalled();
});
it('labels a direct shared fork return without claiming it belongs to the template', async () => {
  saved.blocks = [{ ...identity, key: 'local:shared', assetId: 'owned-copy', source: 'Fork of Shared at revision 1', editable: true,
    entry: { localId: 'shared', source: { kind: 'fork', blockId: 'owned-copy', forkedFrom: { assetId: 'shared', revision: 1 } } } }];
  renderBuilder();
  const button = await screen.findByRole('button', { name: 'Return to shared block' });
  expect(screen.queryByRole('button', { name: 'Return to template' })).toBeNull();
  fireEvent.click(button);
  await settle();
  expect(requests.at(-1)).toEqual({ type: 'return', key: 'local:shared' });
});
