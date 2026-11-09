/**
 * What each plugin API method does, for D126's rule (#3174): while a plugin
 * answers an agent's MCP tool call, it can't do for that agent what the agent
 * couldn't do itself. The plugin-api-factory guard enforces these at the
 * boundary; outside an agent's call nothing is checked, since a plugin acts
 * for the person, with what its manifest allows. Every method has an entry,
 * and plugin-api-grants.test.ts fails when one doesn't, as tool-grants.ts
 * does for the Clubhouse MCP's tools (#2988).
 *
 * - `read`: reads only. Not checked: a known limit (D126).
 * - `plugin`: changes only the plugin's own data (storage, settings, its
 *   workspace, its commands and tools) or what the person sees (dialogs,
 *   badges, navigation, components).
 * - `change`: needs, from the calling agent, a Clubhouse permission on an
 *   agent or a project (checked by main, as the agent's own call would be),
 *   an Access level at least as high as the one the change acts at, or it is
 *   refused during a call because it can't be checked here.
 * - `scope`: returns an API that is guarded the same way (files.forRoot).
 *
 * Files a plugin changes, and the folder a command runs in, are judged in
 * main against the agent (clubhouse-mcp/plugin-file-check.ts): symlinks
 * followed, the real project found, Clubhouse's records and agent
 * configuration held apart from ordinary edits. Typing into a shell has no
 * check at all, so it needs Full access.
 */

import type { AccessLevel } from '../../shared/agent-access';
import type { GrantAction } from '../../shared/agent-grants';
import type { PluginContext, PluginManifest } from '../../shared/plugin-types';
import { useProjectStore } from '../stores/projectStore';
import { resolvePath } from './plugin-api-files';
import { resolveAgentConfigTarget } from './plugin-api-agent-config';

export type PluginApiCheck =
  | { grant: GrantAction; agentId: string }
  | { grant: GrantAction; projectPath: string }
  | { access: AccessLevel; what: string }
  /** A file changed (write, delete) or a command's working folder (exec), judged in main. */
  | { file: string; op: 'write' | 'delete' | 'exec' }
  /** Allowed only when this command id is one the plugin registered itself. */
  | { ownCommand: string }
  | { refuse: string };

export interface GuardScope {
  ctx: PluginContext;
  manifest?: PluginManifest;
  /** The folder a files API is rooted at: the project, or a forRoot root. */
  base?: string;
}

export type PluginApiDeclaration =
  | { kind: 'read' }
  | { kind: 'plugin' }
  /** `sync`: the method returns no promise, so a refusal is thrown rather than a rejection. */
  | { kind: 'change'; checks: (args: readonly unknown[], scope: GuardScope) => PluginApiCheck[]; sync?: true }
  | { kind: 'scope'; as: 'files' };

const READ: PluginApiDeclaration = { kind: 'read' };
const PLUGIN: PluginApiDeclaration = { kind: 'plugin' };
const change = (checks: (args: readonly unknown[], scope: GuardScope) => PluginApiCheck[], sync?: true): PluginApiDeclaration => ({ kind: 'change', checks, ...(sync && { sync }) });

const projectPathOf = (projectId: unknown, scope: GuardScope): string | undefined => {
  if (typeof projectId === 'string' && projectId) return useProjectStore.getState().projects.find((p) => p.id === projectId)?.path;
  return scope.ctx.projectPath;
};

/** A file the plugin writes or deletes, by its full path, for main to judge against the agent. */
function fileChange(base: string | undefined, relativePath: unknown, op: 'write' | 'delete'): PluginApiCheck[] {
  if (!base || typeof relativePath !== 'string') return [{ refuse: 'It can\'t tell which file this is, so it can\'t check it for the agent.' }];
  return [{ file: resolvePath(base, relativePath), op }];
}

const files = (...paths: Array<[number, 'write' | 'delete']>) => change((args, scope) => paths.flatMap(([i, op]) => fileChange(scope.base, args[i], op)));
const projectFile = (op: 'write' | 'delete') => change((args, scope) => fileChange(scope.ctx.projectPath, args[0], op));

/** An agentConfig write: a change to the target project's agent defaults. */
const defaults = (optsIndex: number | null) => change((args, scope) => {
  const projectPath = optsIndex === null
    ? scope.ctx.projectPath
    : resolveAgentConfigTarget(args[optsIndex] as { projectId?: string } | undefined, scope.ctx.projectPath, scope.ctx.pluginId, scope.manifest);
  return projectPath ? [{ grant: 'project.configure', projectPath }] : [{ refuse: 'It has no project to check this against.' }];
});

const OTHER_DESKTOP = change(() => [{ refuse: 'It changes another desktop, which can\'t be checked against the agent\'s permissions here.' }]);

export const PLUGIN_API_GRANTS: Readonly<Record<string, PluginApiDeclaration>> = {
  'project.readFile': READ,
  'project.writeFile': projectFile('write'),
  'project.deleteFile': projectFile('delete'),
  'project.fileExists': READ,
  'project.listDirectory': READ,

  'projects.list': READ,
  'projects.getActive': READ,

  'git.status': READ,
  'git.log': READ,
  'git.currentBranch': READ,
  'git.diff': READ,

  // The plugin's own stored data.
  ...Object.fromEntries((['project', 'projectLocal', 'global'] as const).flatMap((s) => [
    [`storage.${s}.read`, READ], [`storage.${s}.write`, PLUGIN], [`storage.${s}.delete`, PLUGIN], [`storage.${s}.list`, READ],
  ])),

  // What the person sees and answers.
  'ui.EmptyState': PLUGIN,
  'ui.showNotice': PLUGIN,
  'ui.showError': PLUGIN,
  'ui.showConfirm': PLUGIN,
  'ui.showInput': PLUGIN,
  'ui.showApprovalDialog': PLUGIN,
  // The person's browser, signed in, at a page the agent could pick.
  'ui.openExternalUrl': change(() => [{ refuse: 'It opens the person\'s browser, which an agent doesn\'t do.' }]),

  'commands.register': PLUGIN,
  // Its own commands run its own code, guarded the same way; another plugin's or the app's aren't checked for the agent.
  'commands.execute': change((args, scope) => [{ ownCommand: `${scope.ctx.pluginId}:${String(args[0])}` }]),
  'commands.registerWithHotkey': PLUGIN,
  'commands.getBinding': READ,
  'commands.clearBinding': PLUGIN,

  'events.on': READ,

  // The plugin's own settings.
  'settings.get': READ,
  'settings.getAll': READ,
  'settings.set': PLUGIN,
  'settings.onChange': READ,

  'agents.list': READ,
  // On top of the Access cap the method applies (#3161).
  'agents.createDurable': change((args, scope) => {
    const projectPath = projectPathOf((args[0] as { projectId?: unknown } | undefined)?.projectId, scope);
    return projectPath ? [{ grant: 'agent.create', projectPath }] : [];
  }),
  'agents.runQuick': change((args, scope) => {
    const projectPath = projectPathOf((args[1] as { projectId?: unknown } | undefined)?.projectId, scope);
    return projectPath ? [{ grant: 'agent.create', projectPath }] : [];
  }),
  'agents.kill': change((args) => [{ grant: 'agent.sleep', agentId: String(args[0]) }]),
  // With a mission it also delivers a message, as wake_agent's message does.
  'agents.resume': change((args) => [
    { grant: 'agent.wake', agentId: String(args[0]) },
    ...((args[1] as { mission?: unknown } | undefined)?.mission ? [{ grant: 'agent.message' as const, agentId: String(args[0]) }] : []),
  ]),
  'agents.listCompleted': READ,
  'agents.dismissCompleted': PLUGIN,
  'agents.getDetailedStatus': READ,
  'agents.getModelOptions': READ,
  'agents.listOrchestrators': READ,
  'agents.checkOrchestratorAvailability': READ,
  'agents.onStatusChange': READ,
  'agents.onAnyChange': READ,
  'agents.listSessions': READ,
  'agents.readSessionTranscript': READ,
  'agents.getSessionSummary': READ,
  // The plugin's companion starts at Ask first.
  'agents.spawnCompanion': change(() => [{ access: 'ask', what: 'start its companion agent' }]),
  'agents.getCompanionStatus': READ,
  'agents.getCompanionWorkspace': READ,

  'navigation.focusAgent': PLUGIN,
  'navigation.setExplorerTab': PLUGIN,
  'navigation.popOutAgent': PLUGIN,
  'navigation.toggleSidebar': PLUGIN,
  'navigation.toggleAccessoryPanel': PLUGIN,

  'widgets.AgentTerminal': PLUGIN,
  'widgets.AgentView': PLUGIN,
  'widgets.SleepingAgent': PLUGIN,
  'widgets.AgentAvatar': PLUGIN,
  'widgets.QuickAgentGhost': PLUGIN,
  'widgets.PopoutPlaceholder': PLUGIN,

  // A shell runs whatever is typed into it, with no check.
  'terminal.spawn': change(() => [{ access: 'full_access', what: 'open a shell' }]),
  'terminal.write': change(() => [{ access: 'full_access', what: 'type into a shell' }], true),
  'terminal.resize': PLUGIN,
  'terminal.kill': PLUGIN,
  'terminal.getBuffer': READ,
  'terminal.isBusy': READ,
  'terminal.onData': READ,
  'terminal.onExit': READ,
  'terminal.ShellTerminal': PLUGIN,

  'logging.debug': PLUGIN,
  'logging.info': PLUGIN,
  'logging.warn': PLUGIN,
  'logging.error': PLUGIN,
  'logging.fatal': PLUGIN,

  'files.readTree': READ,
  'files.readFile': READ,
  'files.readBinary': READ,
  'files.writeFile': files([0, 'write']),
  'files.stat': READ,
  // Moving a file takes it from one place and puts it in another.
  'files.rename': files([0, 'delete'], [1, 'write']),
  'files.copy': files([1, 'write']),
  'files.mkdir': files([0, 'write']),
  'files.delete': files([0, 'delete']),
  'files.showInFolder': PLUGIN,
  'files.forRoot': { kind: 'scope', as: 'files' },
  'files.search': READ,
  'files.watch': READ,

  // A command from the plugin's allowed list, run with no prompt in the plugin's project (else the home folder).
  'process.exec': change((_args, scope) => (scope.ctx.projectPath
    ? [{ file: scope.ctx.projectPath, op: 'exec' }]
    : [{ access: 'full_access', what: 'run a command outside a project' }])),

  'badges.set': PLUGIN,
  'badges.clear': PLUGIN,
  'badges.clearAll': PLUGIN,

  'agentConfig.injectSkill': defaults(2),
  'agentConfig.removeSkill': defaults(1),
  'agentConfig.listInjectedSkills': READ,
  'agentConfig.injectAgentTemplate': defaults(2),
  'agentConfig.removeAgentTemplate': defaults(1),
  'agentConfig.listInjectedAgentTemplates': READ,
  'agentConfig.appendInstructions': defaults(1),
  'agentConfig.removeInstructionAppend': defaults(0),
  'agentConfig.getInstructionAppend': READ,
  'agentConfig.addPermissionAllowRules': defaults(1),
  'agentConfig.addPermissionDenyRules': defaults(1),
  'agentConfig.removePermissionRules': defaults(0),
  'agentConfig.getPermissionRules': READ,
  'agentConfig.injectMcpServers': defaults(1),
  'agentConfig.removeMcpServers': defaults(0),
  'agentConfig.getInjectedMcpServers': READ,
  // A no-op kept for older plugins (#2901).
  'agentConfig.registerAgentTemplate': PLUGIN,
  'agentConfig.contributeWrapperPreset': defaults(null),
  'agentConfig.removeWrapperPreset': defaults(0),

  'sounds.registerPack': PLUGIN,
  'sounds.unregisterPack': PLUGIN,
  'sounds.listPacks': READ,

  'theme.getCurrent': READ,
  'theme.onDidChange': READ,
  'theme.getColor': READ,

  // The plugin's own workspace folder.
  'workspace.readFile': READ,
  'workspace.writeFile': PLUGIN,
  'workspace.mkdir': PLUGIN,
  'workspace.delete': PLUGIN,
  'workspace.stat': READ,
  'workspace.exists': READ,
  'workspace.listDir': READ,
  'workspace.readTree': READ,
  'workspace.watch': READ,
  'workspace.forPlugin': PLUGIN,
  'workspace.forProject': PLUGIN,

  'canvas.registerWidgetType': PLUGIN,
  'canvas.queryWidgets': READ,

  'window.setTitle': PLUGIN,
  'window.resetTitle': PLUGIN,
  'window.getTitle': READ,
  'window.usePopoutState': READ,

  // Another desktop's agents, terminals, files and group projects.
  'annex.getSatellites': READ,
  'annex.scan': OTHER_DESKTOP,
  'annex.connect': OTHER_DESKTOP,
  'annex.disconnect': OTHER_DESKTOP,
  'annex.retry': OTHER_DESKTOP,
  'annex.getDiscovered': READ,
  'annex.pairWith': OTHER_DESKTOP,
  'annex.forgetSatellite': OTHER_DESKTOP,
  'annex.forgetAllSatellites': OTHER_DESKTOP,
  'annex.agentSpawn': OTHER_DESKTOP,
  'annex.agentKill': OTHER_DESKTOP,
  'annex.agentWake': OTHER_DESKTOP,
  'annex.agentCreateDurable': OTHER_DESKTOP,
  'annex.agentDeleteDurable': OTHER_DESKTOP,
  'annex.agentWorktreeStatus': READ,
  'annex.agentReorder': OTHER_DESKTOP,
  'annex.ptyInput': OTHER_DESKTOP,
  'annex.ptyResize': OTHER_DESKTOP,
  'annex.ptySpawnShell': OTHER_DESKTOP,
  'annex.ptyGetBuffer': READ,
  'annex.clipboardImage': OTHER_DESKTOP,
  'annex.fileTree': READ,
  'annex.fileRead': READ,
  'annex.gitOperation': OTHER_DESKTOP,
  'annex.canvasMutation': OTHER_DESKTOP,
  'annex.sessionList': READ,
  'annex.sessionTranscript': READ,
  'annex.sessionSummary': READ,
  'annex.gpGet': READ,
  'annex.gpUpdate': OTHER_DESKTOP,
  'annex.gpBulletinDigest': READ,
  'annex.gpBulletinTopic': READ,
  'annex.gpBulletinAll': READ,
  'annex.gpBulletinPost': OTHER_DESKTOP,
  'annex.gpShoulderTap': OTHER_DESKTOP,
  'annex.gpDeleteMessage': OTHER_DESKTOP,
  'annex.gpDeleteTopic': OTHER_DESKTOP,
  'annex.gpSetTopicProtection': OTHER_DESKTOP,
  'annex.gpInjectMessage': OTHER_DESKTOP,
  'annex.gpSetPolling': OTHER_DESKTOP,
  'annex.onSatellitesChanged': READ,
  'annex.onDiscoveredChanged': READ,
  'annex.onSatelliteEvent': READ,

  // Its own tools.
  'mcp.contributeTools': PLUGIN,
  'mcp.removeTools': PLUGIN,
  'mcp.listContributedTools': READ,
  'mcp.onToolCall': PLUGIN,
};
