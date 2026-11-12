import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpToolResult } from '../types';

const registered = vi.hoisted(() => new Map<string, {
  handler: (agent: string, args: Record<string, unknown>) => Promise<McpToolResult>;
  options: { group: unknown; grant: unknown };
}>());
const service = vi.hoisted(() => ({ preview: vi.fn(), start: vi.fn(), status: vi.fn(), cancel: vi.fn() }));
vi.mock('../tool-registry', () => ({
  registerGlobalTool: (name: string, _schema: unknown, handler: never, options: never) => { registered.set(name, { handler, options }); },
}));
vi.mock('../../project-import/service', () => ({ projectImportService: service }));
vi.mock('../../log-service', () => ({ appLog: vi.fn() }));

import { registerProjectImportTools } from './project-import-tools';
import { ImportError } from '../../project-import/types';
import { dispatcherSkills } from '../../dispatcher/dispatcher-skills';

async function call(name: string, args: Record<string, unknown>) {
  const result = await registered.get(name)!.handler('dispatcher', args);
  return { body: JSON.parse(result.content[0].text), isError: result.isError === true };
}
beforeEach(() => { registered.clear(); registerProjectImportTools(); });

describe('Dispatcher bounded import tool integration', () => {
  it('registers preview, effect, status and cancellation through normal Dispatcher group/grant declarations', () => {
    expect([...registered.keys()]).toEqual(['preview_github_import', 'import_github_repository', 'get_github_import', 'cancel_github_import']);
    for (const entry of registered.values()) expect(entry.options.group).toBe('dispatcher');
    expect(registered.get('import_github_repository')!.options.grant).toEqual({
      actions: ['project.add'], target: 'project_arg', from: { args: ['destination'] }, askHandledByTool: true,
    });
  });

  it('routes explicit URL/destination/branch to the bounded preview service without initiating import', async () => {
    service.preview.mockResolvedValue({ status: 'ready', plan: { id: 'preview', branch: 'trunk' }, agentCreated: false, agentStarted: false });
    expect(await call('preview_github_import', { url: 'https://github.com/example/repo', destination: '/work/repo', branch: 'trunk' })).toMatchObject({ body: { status: 'ready', agentCreated: false }, isError: false });
    expect(service.preview).toHaveBeenCalledWith('dispatcher', { url: 'https://github.com/example/repo', destination: '/work/repo', branch: 'trunk' });
    expect(service.start).not.toHaveBeenCalled();
  });

  it('keeps real effects disabled until the reviewed human-approval proof API is integrated, even with a preview id', async () => {
    expect(await call('import_github_repository', { planId: 'preview', destination: '/work/repo' })).toMatchObject({
      isError: true, body: { reason: 'approval_boundary_unavailable' },
    });
    expect(service.start).not.toHaveBeenCalled();
  });

  it.each([{ approved: true }, { approvalToken: 'model-text' }, { grantAllow: true }])('never accepts model-manufactured approval fields %j', async (extra) => {
    expect(await call('import_github_repository', { planId: 'preview', destination: '/work/repo', ...extra })).toMatchObject({ isError: true, body: { reason: 'invalid_input' } });
    expect(service.start).not.toHaveBeenCalled();
  });

  it('routes progress/cancellation to the caller-owned import id and preserves partial results', async () => {
    service.status.mockResolvedValue({ phase: 'partial', cloneCompleted: true, projectId: 'proj_real', reason: 'gitignore_failed', agentCreated: false, agentStarted: false });
    expect(await call('get_github_import', { importId: 'owned' })).toMatchObject({ body: { projectId: 'proj_real', phase: 'partial', agentStarted: false } });
    expect(service.status).toHaveBeenCalledWith('dispatcher', 'owned');
    service.cancel.mockResolvedValue({ status: 'cancellation_requested' });
    expect(await call('cancel_github_import', { importId: 'owned', destination: '/work/repo' })).toMatchObject({ body: { status: 'cancellation_requested' } });
    expect(service.cancel).toHaveBeenCalledWith('dispatcher', 'owned', '/work/repo');
  });

  it('sanitizes unexpected private errors but preserves the service’s actionable safe refusals', async () => {
    service.preview.mockRejectedValueOnce(new Error('secret-token private repository'));
    const failed = await call('preview_github_import', { url: 'https://github.com/example/repo', destination: '/work/repo' });
    expect(failed.isError).toBe(true);
    expect(JSON.stringify(failed)).not.toMatch(/secret-token|private repository/);
    service.preview.mockRejectedValueOnce(new ImportError('empty_repository', 'Create a branch on GitHub, then preview again.'));
    expect(await call('preview_github_import', { url: 'https://github.com/example/repo', destination: '/work/repo' })).toMatchObject({ body: { reason: 'empty_repository', message: 'Create a branch on GitHub, then preview again.' } });
  });

  it('ships user/Dispatcher steps for real tools, progress, exact approval, partial recovery and separate template/create/start authority', () => {
    const skill = dispatcherSkills('work').find((s) => s.name === 'importing-repository')!;
    expect(skill.text).toContain('preview_github_import');
    expect(skill.text).toContain('import_github_repository');
    expect(skill.text).toContain('get_github_import');
    expect(skill.text).toContain('cancel_github_import');
    expect(skill.text).toContain('Needs you');
    expect(skill.text).toContain('Free Agent Mode');
    expect(skill.text).toContain('create_managed_agent');
    expect(skill.text).toContain('wake_agent');
    expect(skill.text).toContain('never clone a second copy automatically');
  });
});
