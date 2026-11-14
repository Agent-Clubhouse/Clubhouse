import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManagedPartSummary, ProjectPartReview, ProjectPartsInventory } from '../../../shared/managed-agents-types';
import { ProjectPartsSection } from './ProjectParts';
import { sourceLabel } from './managedApi';

const m = () => window.clubhouse.managed;
const ok = <T,>(value: T) => ({ ok: true, value }) as never;

const inventory: ProjectPartsInventory = {
  projectId: 'proj-1', projectName: 'Demo', notes: [],
  items: [
    { key: 'skill:review', kind: 'skill', name: 'review', state: 'available', hash: 'h1' },
    { key: 'skill:deploy', kind: 'skill', name: 'deploy', state: 'changed', hash: 'h3', partId: 'p-deploy', partName: 'Deploy' },
    { key: 'skill:docs', kind: 'skill', name: 'docs', state: 'added', hash: 'h4', partId: 'p-docs', partName: 'Docs' },
    { key: 'skill:leaky', kind: 'skill', name: 'leaky', state: 'refused', problem: 'The complete skill bundle contains credentials; nothing was imported.' },
    { key: 'mcp:tickets', kind: 'mcp', name: 'tickets', state: 'available', hash: 'h2' },
  ],
  gone: [{ key: 'skill:old', partId: 'p-old', partName: 'Old' }],
};

const summary = (id: string): ManagedPartSummary => ({ id, kind: 'skill', name: id, description: '', builtin: false, revision: 1, updatedAt: '', usedBy: [], templates: [], preview: '' });

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(m(), 'projectParts').mockResolvedValue(ok(inventory));
});

describe('ProjectPartsSection', () => {
  it('lists the repository parts of one kind with their state, and selects nothing by itself', async () => {
    const onUse = vi.fn();
    render(<ProjectPartsSection projectPath="/repo" kind="skill" selected={['p-docs']} onUse={onUse} />);
    const rows = await screen.findAllByTestId('managed-project-part-row');
    expect(rows.map((r) => r.getAttribute('data-state'))).toEqual(['available', 'changed', 'added', 'refused']);
    expect(rows[0].textContent).toContain('Not in the library yet');
    expect(rows[1].textContent).toContain('Changed in the repository');
    expect(rows[2].textContent).toContain('In use');
    expect(rows[3].textContent).toContain('credentials');
    expect(within(rows[3]).queryByRole('button')).toBeNull();
    expect(screen.getByTestId('managed-project-part-gone').textContent).toContain('agents that use it keep it');
    expect(screen.queryByText('tickets')).toBeNull();
    expect(onUse).not.toHaveBeenCalled();
    fireEvent.click(within(rows[1]).getByRole('button', { name: 'Use Deploy' }));
    expect(onUse).toHaveBeenCalledWith({ id: 'p-deploy', kind: 'skill' });
  });

  it('shows nothing for a template or a project with no parts', async () => {
    vi.spyOn(m(), 'projectParts').mockResolvedValue(ok({ ...inventory, items: [], gone: [] }));
    const { container } = render(<ProjectPartsSection projectPath="/repo" kind="block" selected={[]} />);
    await waitFor(() => expect(m().projectParts).toHaveBeenCalled());
    expect(container.textContent).toBe('');
    const none = render(<ProjectPartsSection projectPath={undefined} kind="block" selected={[]} />);
    expect(none.container.textContent).toBe('');
  });

  it('reviews the full content before adding, and adds only when asked', async () => {
    const review: ProjectPartReview = {
      item: inventory.items[0], projectName: 'Demo', droppedEnvValues: [], dependencies: ['git (tool)'],
      content: { kind: 'skill', skillName: 'review', files: [{ path: 'SKILL.md', content: 'Review the change.' }, { path: 'run.sh', content: 'echo', executable: true }] },
      matches: [{ id: 'lib-review', name: 'review', sameContent: false, builtin: false }],
      suggestedName: 'review 2',
    };
    vi.spyOn(m(), 'reviewProjectPart').mockResolvedValue(ok(review));
    const add = vi.spyOn(m(), 'addProjectPart').mockResolvedValue(ok(summary('p-new')));
    const onUse = vi.fn();
    render(<ProjectPartsSection projectPath="/repo" kind="skill" selected={[]} agentName="lead" onUse={onUse} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Review review' }));
    const content = await screen.findByTestId('managed-project-part-content');
    expect(content.textContent).toContain('Review the change.');
    expect(content.textContent).toContain('run.sh (executable)');
    expect(screen.getByTestId('managed-project-part-dependencies').textContent).toContain('git (tool)');
    expect(screen.getByTestId('managed-project-part-name-clash').textContent).toContain('doesn\'t replace it');
    expect((screen.getByTestId('managed-project-part-name') as HTMLInputElement).value).toBe('review 2');
    expect(add).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('managed-project-part-add-use'));
    await waitFor(() => expect(add).toHaveBeenCalledWith('/repo', 'skill:review', 'h1', { mode: 'copy', name: 'review 2' }));
    await waitFor(() => expect(onUse).toHaveBeenCalledWith({ id: 'p-new', kind: 'skill' }));
  });

  it('a repository change shows the difference, and Keep mine leaves the part', async () => {
    const review: ProjectPartReview = {
      item: inventory.items[1], projectName: 'Demo', droppedEnvValues: [], dependencies: [], matches: [], suggestedName: 'deploy',
      content: { kind: 'skill', skillName: 'deploy', files: [{ path: 'SKILL.md', content: 'Deploy on Fridays.' }] },
      current: { id: 'p-deploy', name: 'Deploy', revision: 3, usedBy: 2, content: { kind: 'skill', skillName: 'deploy', files: [{ path: 'SKILL.md', content: 'Never deploy on Fridays.' }] } },
    };
    vi.spyOn(m(), 'reviewProjectPart').mockResolvedValue(ok(review));
    const update = vi.spyOn(m(), 'updateProjectPart');
    const keep = vi.spyOn(m(), 'keepProjectPart').mockResolvedValue(ok(undefined));
    render(<ProjectPartsSection projectPath="/repo" kind="skill" selected={[]} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Review the change to deploy' }));
    const diff = await screen.findByTestId('managed-project-part-diff');
    expect(diff.querySelector('[data-kind="theirs"]')?.textContent).toContain('Never deploy on Fridays.');
    expect(diff.querySelector('[data-kind="yours"]')?.textContent).toContain('Deploy on Fridays.');
    expect(screen.getByText(/used by 2 agents/)).toBeTruthy();
    fireEvent.click(screen.getByTestId('managed-project-part-keep'));
    await waitFor(() => expect(keep).toHaveBeenCalledWith('/repo', 'p-deploy', 'h3'));
    expect(update).not.toHaveBeenCalled();
  });

  it('labels project parts in the library', () => {
    expect(sourceLabel({ builtin: false, usedBy: [], project: { projectId: 'proj-1', projectName: 'Demo' } })).toBe('Project · Demo');
    expect(sourceLabel({ builtin: false, usedBy: [], project: { projectId: 'proj-1' } })).toBe('Project · a removed project');
  });
});
