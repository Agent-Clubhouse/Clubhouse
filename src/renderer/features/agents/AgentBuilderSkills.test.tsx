import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { AgentBuilderSkills } from './AgentBuilderSkills';
import type { BuilderView } from '../../../shared/agent-builder-types';
import type { SkillBundleDocument, SkillBundleEditorBridge } from '../../../shared/skill-bundle-editor-types';

vi.mock('../../components/SettingsMonacoEditor', () => ({ SettingsMonacoEditor: ({ value, onChange, readOnly }: {
  value: string; onChange: (value: string) => void; readOnly?: boolean;
}) => <textarea aria-label="Skill text" value={value} readOnly={readOnly} onChange={(e) => onChange(e.target.value)} /> }));
const document: SkillBundleDocument = { assetId: 'shared', name: 'Shared skill', revision: 1, owner: { kind: 'library' }, source: { kind: 'user' }, readOnly: false,
  payload: { skillName: 'shared', files: [{ path: 'SKILL.md', content: 'Read the guide' }, { path: 'assets/a.bin', content: 'AA==', encoding: 'base64', executable: true }] } };
const view: BuilderView = { revision: 3, templateId: null, templates: [], blocks: [], text: '', customOrder: false, skills: [] };
const selected: BuilderView = { ...view, skillFingerprint: 'reviewed-fingerprint', skills: [{ assetId: 'shared', kind: 'skill', name: document.name, revision: 1, headRevision: 1,
  contentHash: 'exact-hash', owner: document.owner, source: document.source, provenance: [{ via: 'addition' }],
  destination: { kind: 'skill-directory', key: 'skills/shared' }, projection: { kind: 'skill', skillName: 'shared', filePaths: document.payload.files.map((f) => f.path) }, payload: document.payload }] };
let bridge: SkillBundleEditorBridge;
let props: Parameters<typeof AgentBuilderSkills>[0];
beforeEach(() => {
  bridge = { list: vi.fn(async () => ({ ok: true, value: [document] })), read: vi.fn(async () => ({ ok: true, value: document })),
    create: vi.fn(async () => ({ ok: true, value: { ...document, assetId: 'new', owner: { kind: 'agent', agentId: 'agent-1' } } })),
    copy: vi.fn(async () => ({ ok: true, value: { ...document, assetId: 'copy', owner: { kind: 'agent', agentId: 'agent-1' }, source: { kind: 'copy', originAssetId: 'shared', originRevision: 1 } } })),
    preview: vi.fn(), save: vi.fn() };
  window.clubhouse.catalogSkillBundles = bridge;
  window.clubhouse.agentSettings.builderCommand = vi.fn(async (_project, _agent, _revision, action) => ({ ok: true, view: action.type === 'removeSkill' ? { ...view, skillFingerprint: 'remove-fingerprint' } : selected }));
  props = { projectId: 'project-1', projectPath: '/project', agentId: 'agent-1', view, suspended: false,
    onSaved: vi.fn(), onPreview: vi.fn(), onDirtyChange: vi.fn(), onBusyChange: vi.fn() };
});
async function choose() {
  await screen.findByRole('option', { name: /Shared skill/ });
  fireEvent.change(screen.getByLabelText('Catalog skill'), { target: { value: 'shared' } });
  await screen.findByText(/Review the complete bundle before selecting it/);
}
it('saves a complete unassigned bundle before explicit fingerprint-bound assignment', async () => {
  render(<AgentBuilderSkills {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Create skill bundle' }));
  fireEvent.change(screen.getByLabelText('Catalog name'), { target: { value: 'Created' } });
  fireEvent.change(screen.getByLabelText('Skill directory name'), { target: { value: 'created' } });
  fireEvent.change(screen.getByLabelText('Skill text'), { target: { value: 'Complete instructions' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save unassigned bundle' }));
  await screen.findByText('Bundle saved, unassigned. Review and assign it explicitly.');
  expect(bridge.create).toHaveBeenCalledWith({ context: { projectId: 'project-1', agentId: 'agent-1' }, name: 'Created', scope: 'agent', payload: { skillName: 'created', files: [{ path: 'SKILL.md', content: 'Complete instructions' }] } });
  expect(window.clubhouse.agentSettings.builderCommand).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Review assignment' }));
  await screen.findByRole('button', { name: 'Save skill references' });
  expect(props.onSaved).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Save skill references' }));
  await waitFor(() => expect(props.onSaved).toHaveBeenCalledWith(selected));
  expect(window.clubhouse.agentSettings.builderCommand).toHaveBeenLastCalledWith('/project', 'agent-1', 3,
    { type: 'skill', assetId: 'new', expectedRevision: 1, confirm: true, fingerprint: 'reviewed-fingerprint' });
});
it('shows complete read-only binary metadata, cancels shared review, and makes an independent unassigned copy', async () => {
  render(<AgentBuilderSkills {...props} />); await choose();
  fireEvent.click(screen.getByRole('button', { name: 'a.bin (executable)' }));
  expect(screen.getByLabelText('Binary bytes (base64)')).toHaveValue('AA==');
  expect(screen.getByLabelText('Executable metadata')).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Use shared' }));
  await screen.findByRole('button', { name: 'Cancel reference change' });
  fireEvent.click(screen.getByRole('button', { name: 'Cancel reference change' }));
  expect(props.onSaved).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Make copy' }));
  await screen.findByText('Independent copy saved, unassigned. Review and assign it explicitly.');
  expect(bridge.copy).toHaveBeenCalledWith({ context: { projectId: 'project-1', agentId: 'agent-1' }, assetId: 'shared', expectedRevision: 1 });
  expect(screen.getByRole('button', { name: 'Review assignment' })).toBeEnabled();
});
it('previews removal without deleting a bundle or claiming provider load', async () => {
  render(<AgentBuilderSkills {...props} view={selected} />);
  fireEvent.click(screen.getByRole('button', { name: 'Remove reference to Shared skill' }));
  await screen.findByRole('button', { name: 'Save skill references' });
  expect(props.onSaved).not.toHaveBeenCalled();
  expect(screen.getByText(/provider loading remains unverified/)).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Save skill references' }));
  await waitFor(() => expect(props.onSaved).toHaveBeenCalled());
  expect(window.clubhouse.agentSettings.builderCommand).toHaveBeenLastCalledWith('/project', 'agent-1', 3,
    { type: 'removeSkill', assetId: 'shared', confirm: true, fingerprint: 'remove-fingerprint' });
});
it('ignores a late source read after target replacement', async () => {
  let resolve!: (result: Awaited<ReturnType<SkillBundleEditorBridge['read']>>) => void;
  bridge.read = vi.fn(() => new Promise((done) => { resolve = done; }));
  const rendered = render(<AgentBuilderSkills {...props} />);
  await screen.findByRole('option', { name: /Shared skill/ });
  fireEvent.change(screen.getByLabelText('Catalog skill'), { target: { value: 'shared' } });
  rendered.rerender(<AgentBuilderSkills {...props} agentId="other-agent" />);
  await act(async () => resolve({ ok: true, value: document }));
  expect(screen.queryByRole('button', { name: 'Use shared' })).not.toBeInTheDocument();
  expect(props.onSaved).not.toHaveBeenCalled();
});
