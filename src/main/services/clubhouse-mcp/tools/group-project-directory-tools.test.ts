import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../../../shared/ipc-channels';

const mocks = vi.hoisted(() => ({ tools: new Map<string, { handler: (...args: never[]) => Promise<unknown>; options: unknown }>(), list: vi.fn(), members: vi.fn(), window: vi.fn(), send: vi.fn(), show: vi.fn(), focus: vi.fn() }));
vi.mock('../tool-registry', () => ({ registerGlobalTool: (name: string, _definition: unknown, handler: (...args: never[]) => Promise<unknown>, options: unknown) => mocks.tools.set(name, { handler, options }) }));
vi.mock('../../group-project-host', () => ({ groupProjectHost: { list: mocks.list, resolveMembers: mocks.members } }));
vi.mock('../../../ipc/window-handlers', () => ({ findMainWindow: mocks.window }));
import { registerGroupProjectDirectoryTools } from './group-project-directory-tools';

beforeEach(() => {
  vi.resetAllMocks(); mocks.tools.clear();
  mocks.window.mockReturnValue({ webContents: { send: mocks.send }, show: mocks.show, focus: mocks.focus });
  registerGroupProjectDirectoryTools();
});

describe('Dispatcher group project directory tools', () => {
  it('lists host projects and resolved member counts under an app read grant', async () => {
    mocks.list.mockResolvedValue([{ id: 'gp', name: 'Release', scope: { level: 'app', reach: 'local' }, host: { machine: null } }]);
    mocks.members.mockResolvedValue([{ address: 'ada' }, { address: 'bob' }]);
    const tool = mocks.tools.get('list_group_projects')!;
    expect(tool.options).toMatchObject({ group: ['dispatcher', 'dispatcherChat'], grant: { actions: ['settings.app.read'], target: 'app' } });
    const result = await tool.handler() as { content: Array<{ text: string }> };
    expect(JSON.parse(result.content[0].text)).toEqual([{ id: 'gp', name: 'Release', scope: { level: 'app', reach: 'local' }, host: { machine: null }, memberCount: 2 }]);
    expect(mocks.members).toHaveBeenCalledWith('gp');
  });

  it('reports a failed inventory instead of returning an incomplete list', async () => {
    mocks.list.mockRejectedValue(new Error('unavailable'));
    expect(await mocks.tools.get('list_group_projects')!.handler()).toMatchObject({ isError: true });
  });

  it('keeps the rest of the inventory when a project disappears during member resolution', async () => {
    mocks.list.mockResolvedValue([{ id: 'gone', name: 'Gone' }, { id: 'kept', name: 'Kept' }]);
    mocks.members.mockImplementation(async (id: string) => {
      if (id === 'gone') throw new Error('not found');
      return [{ address: 'ada' }];
    });
    const result = await mocks.tools.get('list_group_projects')!.handler() as { content: Array<{ text: string }> };
    expect(JSON.parse(result.content[0].text)).toEqual([
      { id: 'gone', name: 'Gone', scope: null, host: null, memberCount: null },
      { id: 'kept', name: 'Kept', scope: null, host: null, memberCount: 1 },
    ]);
  });

  it('opens the directory in the main window and reports when no window exists', async () => {
    const tool = mocks.tools.get('open_group_project_directory')!;
    expect(tool.options).toMatchObject({ grant: { actions: ['settings.app.read'], target: 'app' } });
    expect(await tool.handler()).toMatchObject({ content: [{ text: expect.stringContaining('Dispatcher pane closes') }] });
    expect(mocks.send).toHaveBeenCalledWith(IPC.APP.OPEN_SETTINGS, 'group-projects');
    expect(mocks.focus).toHaveBeenCalled();
    mocks.window.mockReturnValue(undefined);
    expect(await tool.handler()).toMatchObject({ isError: true });
  });
});
