import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { AssetImpact } from '../../../shared/asset-catalog-types';
import type { SkillBundleDocument, SkillBundleEditorBridge, SkillBundleResult } from '../../../shared/skill-bundle-editor-types';
import { CatalogSkillBundleEditor } from './CatalogSkillBundleEditor';
const delayedEditor = vi.hoisted(() => ({ onChange: undefined as ((value: string) => void) | undefined }));
vi.mock('../../components/SettingsMonacoEditor', () => ({ SettingsMonacoEditor: ({ value, onChange, readOnly }: { value: string; onChange: (value: string) => void; readOnly: boolean }) => {
  delayedEditor.onChange = onChange;
  return <textarea aria-label="Text content" value={value} readOnly={readOnly} onChange={(event) => onChange(event.target.value)} />; } }));
const context = { projectId: 'project-1' };
const document: SkillBundleDocument = { assetId: 'asset-1', name: 'Fixture bundle', revision: 1,
  owner: { kind: 'library' }, source: { kind: 'user' }, readOnly: false,
  payload: { skillName: 'fixture', files: [{ path: 'SKILL.md', content: 'initial' }, { path: 'assets/a.bin', content: 'AA==', encoding: 'base64', executable: true }] } };
const impact: AssetImpact = { assetId: 'asset-1', fromRevision: 1, toRevision: 2, agents: [], templates: [], subagents: [], copies: [], sharedDestinations: [], blocked: false, fingerprint: 'fixture' };
const success = <T,>(value: T): SkillBundleResult<T> => ({ ok: true, value });
let bridge: SkillBundleEditorBridge;
beforeEach(() => { bridge = { read: vi.fn(async () => success(document)), list: vi.fn(),
  preview: vi.fn(async () => success({ token: 'token', impact, blocked: false })),
  save: vi.fn(async () => success({ ...document, revision: 2, payload: { ...document.payload, files: [{ ...document.payload.files[0], content: 'edited' }, document.payload.files[1]] } })) }; });
const renderEditor = () => render(<CatalogSkillBundleEditor context={context} assetId="asset-1" bridge={bridge} />);
async function edit() { await screen.findByDisplayValue('initial'); fireEvent.change(screen.getByLabelText('Text content'), { target: { value: 'edited' } }); }
async function review() { fireEvent.click(screen.getByRole('button', { name: 'Review catalog edit' })); await waitFor(() => expect(screen.getByRole('button', { name: 'Save catalog revision' })).toBeEnabled()); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }

it('makes saved-only scope persistent and saves exactly the complete reviewed bundle', async () => {
  renderEditor(); await edit();
  expect(screen.getByText('Catalog copy only. Saving does not assign, enable or run this skill.')).toBeVisible();
  expect(screen.getByText(/Source: user.*Owner: library/)).toBeVisible();
  await review();
  expect(bridge.preview).toHaveBeenCalledWith({ context, assetId: 'asset-1', expectedRevision: 1, payload: { ...document.payload, files: [{ ...document.payload.files[0], content: 'edited' }, document.payload.files[1]] } });
  fireEvent.click(screen.getByRole('button', { name: 'Save catalog revision' }));
  await screen.findByText(/Catalog revision 2/);
  expect(bridge.save).toHaveBeenCalledWith({ context, assetId: 'asset-1', expectedRevision: 1, token: 'token' });
  expect(screen.getByRole('button', { name: 'Save catalog revision' })).toBeDisabled();
});
it('invalidates preview on text, executable metadata and supporting file changes', async () => {
  renderEditor(); await edit(); await review();
  fireEvent.click(screen.getByLabelText('Executable metadata'));
  expect(screen.getByRole('button', { name: 'Save catalog revision' })).toBeDisabled();
  await review();
  fireEvent.change(screen.getByLabelText('Relative path'), { target: { value: 'scripts/check.sh' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add file' }));
  expect(screen.getByRole('button', { name: 'Save catalog revision' })).toBeDisabled();
});
it('visibly blocks shared impact and never offers a save', async () => {
  vi.mocked(bridge.preview).mockResolvedValue(success({ token: '', impact: { ...impact, subagents: ['subagent-1'] }, blocked: true }));
  renderEditor(); await edit(); fireEvent.click(screen.getByRole('button', { name: 'Review catalog edit' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Shared edits are blocked');
  expect(screen.getByRole('button', { name: 'Save catalog revision' })).toBeDisabled(); expect(bridge.save).not.toHaveBeenCalled();
});
it.each(['stale_revision', 'save_failed'] as const)('shows %s and preserves all unsaved bytes until explicit reload', async (code) => {
  vi.mocked(bridge.save).mockResolvedValue({ ok: false, code });
  renderEditor(); await edit(); await review(); fireEvent.click(screen.getByRole('button', { name: 'Save catalog revision' }));
  await screen.findByRole('alert'); expect(screen.getByLabelText('Text content')).toHaveValue('edited');
  fireEvent.click(screen.getByRole('button', { name: 'Reload saved bundle and discard edits' }));
  await waitFor(() => expect(screen.getByLabelText('Text content')).toHaveValue('initial'));
});
it('does not show late results from a prior target and keeps the new revision on screen', async () => {
  const late = deferred<SkillBundleResult<SkillBundleDocument>>();
  vi.mocked(bridge.read).mockReturnValueOnce(late.promise).mockResolvedValueOnce(success({ ...document, name: 'Second', assetId: 'asset-2', revision: 7 }));
  const { rerender } = renderEditor();
  rerender(<CatalogSkillBundleEditor context={{ projectId: 'project-2' }} assetId="asset-2" bridge={bridge} />);
  await screen.findByText('Second');
  await act(async () => late.resolve(success(document)));
  expect(screen.getByText('Second')).toBeVisible(); expect(screen.queryByText('Fixture bundle')).not.toBeInTheDocument();
});
it('ignores old target preview replies and their errors after target switch', async () => {
  const late = deferred<Awaited<ReturnType<SkillBundleEditorBridge['preview']>>>();
  vi.mocked(bridge.preview).mockReturnValue(late.promise);
  const { rerender } = renderEditor(); await edit(); fireEvent.click(screen.getByRole('button', { name: 'Review catalog edit' }));
  rerender(<CatalogSkillBundleEditor context={context} assetId="asset-2" bridge={bridge} />);
  await waitFor(() => expect(screen.getByLabelText('Text content')).toHaveValue('initial'));
  await act(async () => late.resolve({ ok: false, code: 'stale_preview' }));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Save catalog revision' })).toBeDisabled();
});
it('shows builtin provenance and hides every edit/save operation', async () => {
  vi.mocked(bridge.read).mockResolvedValue(success({ ...document, source: { kind: 'builtin', builtinId: 'fixture' }, readOnly: true }));
  renderEditor(); await screen.findByText(/Built-in, read-only/);
  expect(screen.getByLabelText('Text content')).toHaveAttribute('readonly');
  expect(screen.queryByRole('button', { name: 'Review catalog edit' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Save catalog revision' })).not.toBeInTheDocument();
});

it.each(['preview', 'save'] as const)('ignores delayed same-target Monaco change while %s is pending without sticking busy or discarding a newer draft', async (operation) => {
  const latePreview = deferred<Awaited<ReturnType<SkillBundleEditorBridge['preview']>>>();
  const lateSave = deferred<Awaited<ReturnType<SkillBundleEditorBridge['save']>>>();
  renderEditor(); await edit();
  const queued = delayedEditor.onChange!;
  if (operation === 'preview') {
    vi.mocked(bridge.preview).mockReturnValueOnce(latePreview.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Review catalog edit' }));
  } else {
    await review(); vi.mocked(bridge.save).mockReturnValueOnce(lateSave.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Save catalog revision' }));
  }
  act(() => queued('late queued editor event'));
  expect(screen.getByLabelText('Text content')).toHaveValue('edited');
  if (operation === 'preview') await act(async () => latePreview.resolve(success({ token: 'token', impact, blocked: false })));
  else await act(async () => lateSave.resolve(success({ ...document, revision: 2, payload: { ...document.payload, files: [{ ...document.payload.files[0], content: 'edited' }, document.payload.files[1]] } })));
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Text content'), { target: { value: 'newer draft' } });
  expect(screen.getByLabelText('Text content')).toHaveValue('newer draft');
  expect(screen.getByRole('button', { name: 'Save catalog revision' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Review catalog edit' })).toBeEnabled();
});
