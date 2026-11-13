/** Dispatcher access to the local group project directory. */
import { IPC } from '../../../../shared/ipc-channels';
import { findMainWindow } from '../../../ipc/window-handlers';
import { groupProjectHost } from '../../group-project-host';
import { registerGlobalTool } from '../tool-registry';
import type { McpToolResult } from '../types';

const result = (value: string, isError = false): McpToolResult => ({ content: [{ type: 'text', text: value }], ...(isError && { isError: true }) });
const options = { group: ['dispatcher', 'dispatcherChat'] as const, grant: { actions: ['settings.app.read'], target: 'app' } } as const;

export function registerGroupProjectDirectoryTools(): void {
  registerGlobalTool('list_group_projects', {
    description: 'List group projects on this host with their name, scope, host and member count.',
    inputSchema: { type: 'object', properties: {} },
  }, async () => {
    try {
      const projects = await groupProjectHost.list();
      const entries = await Promise.all(projects.map(async (project) => ({
        id: project.id, name: project.name, scope: project.scope ?? null, host: project.host ?? null,
        memberCount: await groupProjectHost.resolveMembers(project.id).then((members) => members.length).catch((): number | null => null),
      })));
      return result(JSON.stringify(entries));
    } catch (error) {
      // telemetry-exempt: the failure is returned without pretending the inventory is complete.
      return result(`Could not list group projects: ${error instanceof Error ? error.message : String(error)}`, true);
    }
  }, options);

  registerGlobalTool('open_group_project_directory', {
    description: 'Open Settings > Group Projects in the main Clubhouse window.',
    inputSchema: { type: 'object', properties: {} },
  }, async () => {
    const main = findMainWindow();
    if (!main) return result('The main Clubhouse window is unavailable.', true);
    main.webContents.send(IPC.APP.OPEN_SETTINGS, 'group-projects');
    main.show();
    main.focus();
    return result('Requested the Group Projects directory in the main window. The Dispatcher pane closes.');
  }, { ...options, group: 'dispatcher' });
}
