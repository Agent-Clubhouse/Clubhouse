import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import type { AssetImpact } from '../../../shared/asset-catalog-types';
import type { SkillBundleDocument, SkillBundleEditorBridge } from '../../../shared/skill-bundle-editor-types';
import { SkillLibrarySettingsView } from './SkillLibrarySettingsView';
import { SettingsNav } from '../../chrome/sidebar/SettingsNav';
import { MainContentView } from '../../panels/MainContentView';
import { useUIStore } from '../../stores/uiStore';
import { useProjectStore } from '../../stores/projectStore';
import { showConfirmDialog } from '../../plugins/PluginDialog';

const retained = vi.hoisted(() => ({ save: undefined as (() => void) | undefined,
  refresh: undefined as (() => void) | undefined, busy: undefined as ((value: boolean, operation: number) => void) | undefined,
  saved: undefined as ((document: SkillBundleDocument, operation: number) => void) | undefined }));
vi.mock('../../components/Button', async (original) => {
  const actual = await original<typeof import('../../components/Button')>();
  return { ...actual, Button: (props: import('react').ComponentProps<typeof actual.Button>) => {
    if (props.children === 'Save catalog revision') retained.save = () => props.onClick?.(undefined);
    if (Array.isArray(props.children) && props.children[0] === 'Refresh list') retained.refresh = () => props.onClick?.(undefined);
    return <actual.Button {...props} />;
  } };
});
vi.mock('../skills/CatalogSkillBundleEditor', async (original) => {
  const actual = await original<typeof import('../skills/CatalogSkillBundleEditor')>();
  return { ...actual, CatalogSkillBundleEditor: (props: import('react').ComponentProps<typeof actual.CatalogSkillBundleEditor>) => {
    retained.busy = props.onBusyChange; retained.saved = props.onSaved;
    return <actual.CatalogSkillBundleEditor {...props} />;
  } };
});
vi.mock('../../components/SettingsMonacoEditor', () => ({ SettingsMonacoEditor: ({ value, onChange, readOnly }: { value: string; onChange: (value: string) => void; readOnly: boolean }) =>
  <textarea aria-label="Text content" value={value} readOnly={readOnly} onChange={(event) => onChange(event.target.value)} /> }));
vi.mock('../../plugins/PluginDialog', async (original) => ({ ...(await original<typeof import('../../plugins/PluginDialog')>()), showConfirmDialog: vi.fn() }));
vi.mock('./DisplaySettingsView', () => ({ DisplaySettingsView: () => <button>Other settings control</button> }));
vi.mock('../agents/AgentTerminal', () => ({ AgentTerminal: () => null }));
vi.mock('../agents/chat/AgentRuntimePane', () => ({ AgentRuntimePane: () => null }));

const projects = [{ id: 'p1', name: 'Alpha', path: '/synthetic/alpha' }, { id: 'p2', name: 'Beta', path: '/synthetic/beta' }];
const doc = (assetId: string, name: string): SkillBundleDocument => ({ assetId, name, revision: 1, readOnly: false, owner: { kind: 'library' }, source: { kind: 'user' },
  payload: { skillName: assetId, files: [{ path: 'SKILL.md', content: `initial ${assetId}` }, { path: 'scripts/check.sh', content: 'exit 9', executable: true }, { path: 'assets/a.bin', content: 'AA==', encoding: 'base64', executable: true }] } });
const impact: AssetImpact = { assetId: 'one', fromRevision: 1, toRevision: 2, agents: [], templates: [], subagents: [], copies: [], sharedDestinations: [], blocked: false, fingerprint: 'fixture' };
let documents: Record<string, SkillBundleDocument>, bridge: SkillBundleEditorBridge;
beforeEach(() => {
  documents = { one: doc('one', 'First bundle'), two: doc('two', 'Second bundle'), builtin: { ...doc('builtin', 'Built-in bundle'), source: { kind: 'builtin', builtinId: 'fixture' }, readOnly: true } };
  const pending = new Map<string, Parameters<SkillBundleEditorBridge['preview']>[0]>();
  bridge = {
    list: vi.fn(async () => ({ ok: true, value: Object.values(documents).map(({ payload: _payload, ...summary }) => summary) })),
    read: vi.fn(async (_context, assetId) => ({ ok: true, value: structuredClone(documents[assetId]) })),
    preview: vi.fn(async (request) => { pending.set('fixture-token', structuredClone(request)); return { ok: true, value: { token: 'fixture-token', impact, blocked: false } }; }),
    save: vi.fn(async (request) => { const reviewed = pending.get(request.token)!; const value = { ...documents[request.assetId], revision: 2, payload: reviewed.payload }; documents[request.assetId] = value; return { ok: true, value }; }),
  };
  Object.assign(window.clubhouse, { catalogSkillBundles: bridge });
  useProjectStore.setState({ projects, activeProjectId: 'p2' });
  useUIStore.setState({ explorerTab: 'settings', settingsContext: 'app', settingsSubPage: 'display' });
  vi.mocked(showConfirmDialog).mockReturnValue({ promise: Promise.resolve(true) } as never);
});
const chooseProject = async (id = 'p1') => {
  fireEvent.change(screen.getByRole('combobox', { name: 'Registered project' }), { target: { value: id } });
  await screen.findByRole('button', { name: /First bundle/ });
};
const chooseAsset = async (name = 'First bundle', initial = 'initial one') => {
  const row = await screen.findByRole('button', { name: new RegExp(name) });
  await waitFor(() => expect(row).toBeEnabled());
  fireEvent.click(row);
  await screen.findByDisplayValue(initial);
  await waitFor(() => expect(screen.getByRole('combobox', { name: 'Registered project' })).toBeEnabled());
};
const edit = () => fireEvent.change(screen.getByLabelText('Text content'), { target: { value: 'edited' } });
const review = async () => { fireEvent.click(screen.getByRole('button', { name: 'Review catalog edit' })); await waitFor(() => expect(screen.getByRole('button', { name: 'Save catalog revision' })).toBeEnabled()); };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
const mountRoute = () => render(<><SettingsNav /><MainContentView /></>);
const openRoute = () => fireEvent.click(screen.getByTestId('settings-nav-app-skill-library'));

it('opens the actual App Settings destination and requires an explicit registered project', async () => {
  mountRoute(); openRoute();
  expect(screen.getByRole('heading', { name: 'Skill library' })).toBeVisible();
  expect(bridge.list).not.toHaveBeenCalled();
  await chooseProject();
  expect(bridge.list).toHaveBeenCalledWith({ projectId: 'p1' });
  expect(useProjectStore.getState().activeProjectId).toBe('p2');
  await chooseAsset(); expect(within(screen.getByRole('region', { name: 'Catalog skill bundle' })).getByText(/Source: user.*Owner: library/)).toBeVisible();
});
it('shows builtin source/revision and readonly bundle details', async () => {
  render(<SkillLibrarySettingsView visible bridge={bridge} />); await chooseProject(); await chooseAsset('Built-in bundle', 'initial builtin');
  expect(screen.getByLabelText('Text content')).toHaveAttribute('readonly');
  expect(screen.getByText(/Catalog revision 1.*Source: builtin/)).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Save catalog revision' })).not.toBeInTheDocument();
});
it('saves the full reviewed bundle and updates list revision without dropping binary or executable members', async () => {
  render(<SkillLibrarySettingsView visible bridge={bridge} />); await chooseProject(); await chooseAsset(); edit(); await review();
  fireEvent.click(screen.getByRole('button', { name: 'Save catalog revision' }));
  await screen.findByText(/Catalog revision 2/);
  await waitFor(() => expect(screen.getByRole('button', { name: /First bundle.*Revision 2/ })).toBeVisible());
  expect(documents.one.payload.files.slice(1)).toEqual(doc('one', 'First bundle').payload.files.slice(1));
});
it('confirms draft discard for selection, project change and refresh, preserving edits on cancel', async () => {
  render(<SkillLibrarySettingsView visible bridge={bridge} />); await chooseProject(); await chooseAsset(); edit();
  vi.mocked(showConfirmDialog).mockReturnValueOnce({ promise: Promise.resolve(false) } as never);
  fireEvent.click(screen.getByRole('button', { name: /Second bundle/ }));
  await act(async () => {}); expect(screen.getByLabelText('Text content')).toHaveValue('edited');
  const nextList = deferred<Awaited<ReturnType<SkillBundleEditorBridge['list']>>>();
  vi.mocked(bridge.list).mockReturnValueOnce(nextList.promise);
  fireEvent.change(screen.getByRole('combobox', { name: 'Registered project' }), { target: { value: 'p2' } });
  await waitFor(() => expect(screen.queryByLabelText('Text content')).not.toBeInTheDocument());
  expect(showConfirmDialog).toHaveBeenCalledWith('Discard unsaved skill bundle changes?');
  expect(screen.queryByRole('button', { name: /First bundle/ })).not.toBeInTheDocument();
  expect(screen.getByRole('combobox', { name: 'Registered project' })).toBeDisabled();
  const selection = chooseAsset();
  await act(async () => nextList.resolve({ ok: true, value: Object.values(documents) }));
  await selection; edit();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh list and discard edits' }));
  await waitFor(() => expect(screen.queryByLabelText('Text content')).not.toBeInTheDocument());
});
it('ignores a deferred old project list response including its error', async () => {
  const old = deferred<Awaited<ReturnType<SkillBundleEditorBridge['list']>>>();
  vi.mocked(bridge.list).mockReturnValueOnce(old.promise);
  render(<SkillLibrarySettingsView visible bridge={bridge} />);
  fireEvent.change(screen.getByRole('combobox', { name: 'Registered project' }), { target: { value: 'p1' } });
  act(() => useProjectStore.setState({ projects: [{ ...projects[0], path: '/synthetic/remapped' }, projects[1]] }));
  await screen.findByRole('button', { name: /First bundle/ });
  await act(async () => old.resolve({ ok: false, code: 'target_changed' }));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});
it('preserves a draft across navigation and excludes the hidden editor from keyboard navigation', async () => {
  mountRoute(); openRoute(); await chooseProject(); await chooseAsset(); edit();
  const save = retained.save!;
  fireEvent.click(screen.getByTestId('settings-nav-app-display'));
  const pane = screen.getByTestId('skill-library-pane'); expect(pane).toHaveAttribute('hidden'); expect(pane).toHaveAttribute('inert');
  expect(screen.queryByRole('textbox', { name: 'Text content' })).not.toBeInTheDocument();
  screen.getByRole('button', { name: 'Other settings control' }).focus(); await userEvent.tab();
  expect(pane.contains(document.activeElement)).toBe(false);
  act(() => save()); expect(bridge.save).not.toHaveBeenCalled();
  openRoute(); await waitFor(() => expect(screen.getByRole('textbox', { name: 'Text content' })).toHaveValue('edited'));
  expect(showConfirmDialog).not.toHaveBeenCalled();
});
it.each(['success', 'failure'] as const)('keeps truthful pending save %s while hidden, rejecting obsolete busy/saved notifications', async (outcome) => {
  const saved = deferred<Awaited<ReturnType<SkillBundleEditorBridge['save']>>>();
  mountRoute(); openRoute(); await chooseProject(); await chooseAsset(); edit(); await review();
  const busy = retained.busy!, notifySaved = retained.saved!, refresh = retained.refresh!;
  vi.mocked(bridge.save).mockReturnValueOnce(saved.promise);
  fireEvent.click(screen.getByRole('button', { name: 'Save catalog revision' }));
  const calls = vi.mocked(bridge.list).mock.calls.length;
  act(() => { busy(false, 1); notifySaved({ ...documents.one, revision: 99 }, 1); refresh(); });
  expect(vi.mocked(bridge.list).mock.calls).toHaveLength(calls);
  expect(screen.getByRole('combobox', { name: 'Registered project' })).toBeDisabled();
  fireEvent.click(screen.getByTestId('settings-nav-app-display'));
  if (outcome === 'success') {
    documents.one = { ...documents.one, revision: 2, payload: { ...documents.one.payload, files: [{ ...documents.one.payload.files[0], content: 'edited' }, ...documents.one.payload.files.slice(1)] } };
    await act(async () => saved.resolve({ ok: true, value: documents.one }));
  } else await act(async () => saved.resolve({ ok: false, code: 'save_failed' }));
  openRoute();
  await waitFor(() => expect(screen.getByRole('combobox', { name: 'Registered project' })).toBeEnabled());
  expect(screen.getByRole('textbox', { name: 'Text content' })).toHaveValue('edited');
  expect(screen.getByText(new RegExp(`Catalog revision ${outcome === 'success' ? 2 : 1}`))).toBeVisible();
  if (outcome === 'failure') expect(screen.getByRole('alert')).toHaveTextContent('operation failed');
});
it.each(['remove', 'remap'] as const)('revokes the hidden selected context after project %s and ignores old callbacks', async (change) => {
  mountRoute(); openRoute(); await chooseProject(); await chooseAsset(); edit(); await review(); const save = retained.save!;
  fireEvent.click(screen.getByTestId('settings-nav-app-display'));
  act(() => useProjectStore.setState({ projects: change === 'remove' ? [projects[1]] : [{ ...projects[0], path: '/synthetic/remapped' }, projects[1]] }));
  act(() => save()); expect(bridge.save).not.toHaveBeenCalled(); openRoute();
  expect(screen.queryByRole('textbox', { name: 'Text content' })).not.toBeInTheDocument();
});
it.each(['revision', 'delete'] as const)('reconciles hidden selected asset %s before allowing another edit', async (change) => {
  mountRoute(); openRoute(); await chooseProject(); await chooseAsset(); edit(); await review();
  fireEvent.click(screen.getByTestId('settings-nav-app-display'));
  if (change === 'revision') documents.one = { ...documents.one, revision: 2 }; else delete documents.one;
  openRoute(); await screen.findByText('The selected catalog skill changed or was removed. Refresh the list before editing again.');
  expect(screen.getByRole('button', { name: 'Save catalog revision' })).toBeDisabled();
  expect(screen.getByRole('textbox', { name: 'Text content' })).toHaveValue('edited');
});
it('shows list errors visibly and refresh retries the same registered scope', async () => {
  vi.mocked(bridge.list).mockResolvedValueOnce({ ok: false, code: 'save_failed' });
  render(<SkillLibrarySettingsView visible bridge={bridge} />);
  fireEvent.change(screen.getByRole('combobox', { name: 'Registered project' }), { target: { value: 'p1' } });
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not read');
  fireEvent.click(screen.getByRole('button', { name: 'Refresh list' })); await screen.findByRole('button', { name: /First bundle/ });
});

it('ignores a deferred discard confirmation after leaving and returning to the page', async () => {
  mountRoute(); openRoute(); await chooseProject(); await chooseAsset(); edit();
  const confirmation = deferred<boolean>();
  vi.mocked(showConfirmDialog).mockReturnValueOnce({ promise: confirmation.promise } as never);
  fireEvent.click(screen.getByRole('button', { name: /Second bundle/ }));
  fireEvent.click(screen.getByTestId('settings-nav-app-display'));
  await act(async () => confirmation.resolve(true));
  openRoute();
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Text content' })).toHaveValue('edited'));
  expect(screen.getByRole('heading', { name: 'First bundle' })).toBeVisible();
});
