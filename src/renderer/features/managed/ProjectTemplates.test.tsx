import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectTemplateReview, ProjectTemplatesInventory } from '../../../shared/managed-agents-types';
import { ProjectTemplatesSection } from './ProjectTemplates';

const m = () => window.clubhouse.managed;
const ok = <T,>(value: T) => ({ ok: true, value }) as never;

const inventory: ProjectTemplatesInventory = {
  projectPath: '/repo', projectId: 'proj-1', projectName: 'Demo', notes: [],
  items: [
    { key: 'reviewer', name: 'Reviewer', state: 'available', hash: 'h1' },
    { key: 'release', name: 'Release', state: 'changed', hash: 'h2', templateId: 't-release', templateName: 'Release' },
    { key: 'file:bad.json', name: 'bad.json', state: 'refused', problem: 'The template has fields Clubhouse doesn\'t take.' },
  ],
  gone: [{ key: 'old', templateId: 't-old', templateName: 'Old' }],
};

const permission = { kind: 'setting' as const, key: 'access', from: 'Default', to: 'Full access' };

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(m(), 'projectTemplates').mockResolvedValue(ok([inventory]));
});

describe('ProjectTemplatesSection', () => {
  it('lists each project\'s templates with their state', async () => {
    render(<ProjectTemplatesSection onNotice={vi.fn()} />);
    const rows = await screen.findAllByTestId('managed-project-template-row');
    expect(rows.map((r) => r.getAttribute('data-state'))).toEqual(['available', 'changed', 'refused']);
    expect(within(rows[2]).queryByRole('button')).toBeNull();
    expect(screen.getByTestId('managed-project-template-gone').textContent).toContain('agents made from it');
  });

  it('a part not added yet blocks adding; permissions need their own tick', async () => {
    const review = (): ProjectTemplateReview => ({
      item: inventory.items[0], projectName: 'Demo', description: 'Reviews PRs.', notes: [], suggestedName: 'Reviewer',
      refs: [{ ref: 'skill:review', kind: 'skill', partId: 'p1', partName: 'Review' }],
      settings: [{ kind: 'setting', key: 'model', from: 'unset', to: 'opus' }],
      permissions: [permission],
    });
    const reviewFn = vi.spyOn(m(), 'reviewProjectTemplate').mockImplementation(async () => ok(review()));
    const add = vi.spyOn(m(), 'addProjectTemplate').mockResolvedValue(ok({ id: 't1', name: 'Reviewer' }));
    const onNotice = vi.fn();
    render(<ProjectTemplatesSection onNotice={onNotice} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Review Reviewer' }));
    expect((await screen.findByTestId('managed-project-template-permissions')).textContent).toContain('Access Default → Full access');
    expect((screen.getByTestId('managed-project-template-approve') as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByTestId('managed-project-template-add'));
    await waitFor(() => expect(add).toHaveBeenCalledWith('/repo', 'reviewer', 'h1', { name: 'Reviewer', approvePermissions: false }));
    expect(onNotice).toHaveBeenCalledWith('Added Reviewer.');
    expect(reviewFn).toHaveBeenCalledWith('/repo', 'reviewer', false);
  });

  it('an unresolved part disables Add and says what to do', async () => {
    vi.spyOn(m(), 'reviewProjectTemplate').mockResolvedValue(ok({
      item: inventory.items[0], projectName: 'Demo', description: '', notes: [], suggestedName: 'Reviewer', settings: [], permissions: [],
      refs: [{ ref: 'skill:review', kind: 'skill', unresolved: 'not_added' }],
    } satisfies ProjectTemplateReview));
    render(<ProjectTemplatesSection onNotice={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Review Reviewer' }));
    const refs = await screen.findByTestId('managed-project-template-refs');
    expect(refs.textContent).toContain('Add it from the project first');
    expect((screen.getByTestId('managed-project-template-add') as HTMLButtonElement).disabled).toBe(true);
  });

  it('a change goes through the template push dialog, and only ticked agents get it', async () => {
    const target = (agentId: string, running: boolean) => ({ projectPath: '/repo', agentId, agentName: agentId, color: 'indigo', running, applicable: 1, total: 1 });
    vi.spyOn(m(), 'reviewProjectTemplate').mockResolvedValue(ok({
      item: inventory.items[1], projectName: 'Demo', description: '', notes: [], suggestedName: 'Release', settings: [], permissions: [], refs: [],
      current: { id: 't-release', name: 'Release', consumers: 2 },
      push: { changes: [{ kind: 'add', part: 'block', id: 'b1', name: 'Tagging' }], targets: [target('lead', true), target('scout', false)] },
    } satisfies ProjectTemplateReview));
    const update = vi.spyOn(m(), 'updateProjectTemplate').mockResolvedValue(ok({ failed: [] }));
    const keep = vi.spyOn(m(), 'keepProjectTemplate');
    render(<ProjectTemplatesSection onNotice={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Review the change to Release' }));
    fireEvent.click(await screen.findByTestId('managed-project-template-continue'));
    const dialog = await screen.findByTestId('managed-template-push-dialog');
    expect(within(dialog).getByTestId('managed-template-targets').textContent).toContain('applies on restart');
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Apply to scout' }));
    fireEvent.click(within(dialog).getByTestId('managed-template-save-apply'));
    await waitFor(() => expect(update).toHaveBeenCalledWith('/repo', 't-release', 'h2', { approvePermissions: false, targets: [{ projectPath: '/repo', agentId: 'lead' }] }));
    expect(keep).not.toHaveBeenCalled();
  });
});
