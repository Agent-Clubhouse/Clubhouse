import type { GroupProject, GroupProjectScope } from '../../shared/group-project-types';
import type { DurableAgentConfig, Project } from '../../shared/types';
import { inferLegacyGroupProjectScope } from '../../shared/group-project-scope';
import { isDisposedAgent } from '../../shared/agent-helpers';
import * as projectStore from './project-store';
import * as agentConfig from './agent-config';
import { agentRegistry } from './agent-registry';
import { bindingManager } from './clubhouse-mcp/binding-manager';
import {
  globalCanvasKvDir, projectCanvasKvDir, readCanvasStore, type CanvasStoreLocation,
} from './canvas-store-reader';
import { bindingsFromCanvasStores } from './canvas-wire-source';
import {
  bindingsFromConnections, peekConnectionsChecked, type OrchestratorConnection, type ScopedAgent,
} from './orchestrator-connections';
import { isBindingRemovedByUser, type PersistedBinding } from './persisted-bindings';

export class GroupProjectScopeMigrationError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'GroupProjectScopeMigrationError';
  }
}

async function checked<T>(label: string, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    throw new GroupProjectScopeMigrationError(
      `${label}: ${error instanceof Error ? error.message : String(error)}`, error,
    );
  }
}

interface Inventory {
  project: Project;
  key: string;
  agents: readonly DurableAgentConfig[];
  agentsSignature: string;
  connections: OrchestratorConnection[];
  connectionsSignature: string;
}

function projectSignature(projects: readonly Project[]): string {
  return JSON.stringify(projects.map((project) => [project.id, project.path]).sort());
}

export interface LegacyGroupProjectScopeInventory {
  scopes: Map<string, GroupProjectScope>;
  assertUnchanged(): Promise<void>;
}

/** Read every legacy membership source without drawing wires or repairing stores. */
export async function collectLegacyGroupProjectScopes(projects: readonly GroupProject[]): Promise<LegacyGroupProjectScopeInventory> {
  const legacy = projects.filter((project) => project.scope === undefined);
  if (legacy.length === 0) return { scopes: new Map(), assertUnchanged: async () => {} };
  const generation = agentConfig.agentConfigGeneration();
  const bindingsVersion = bindingManager.getVersion();
  const liveBindingsSignature = JSON.stringify(bindingManager.getAllBindings());
  const registrations = [...agentRegistry.getAllRegistrations()].map(([id, registration]) => [id, { ...registration }] as const);
  const registrationsSignature = JSON.stringify(registrations);
  const registered = (await checked('Cannot list registered projects', () => projectStore.list()))
    .map((project) => ({ ...project }));
  const signature = projectSignature(registered);
  if (new Set(registered.map((project) => project.id)).size !== registered.length) {
    throw new GroupProjectScopeMigrationError('Registered projects contain ambiguous identities.');
  }
  const inventory: Inventory[] = [];
  for (const project of registered) {
    const config = await checked(`Cannot read agents in ${project.path}`, () => agentConfig.peekDurableConfigsChecked(project.path, { strict: true }));
    if (!config.readable) throw new GroupProjectScopeMigrationError(`Cannot read agents in ${project.path}.`);
    const agentsSignature = JSON.stringify(config.agents);
    const connections = await checked(`Cannot read connections in ${project.path}`, () => peekConnectionsChecked(project.path));
    inventory.push({
      project, agents: config.agents, agentsSignature, connections,
      connectionsSignature: JSON.stringify(connections),
      key: await checked(`Cannot identify ${project.path}`, () => agentConfig.projectKey(project.path)),
    });
  }
  const locations: CanvasStoreLocation[] = [
    { scope: 'app', kvDir: globalCanvasKvDir() },
    ...registered.map((project): CanvasStoreLocation => ({
      scope: 'project', projectId: project.id, projectName: project.name,
      projectPath: project.path, kvDir: projectCanvasKvDir(project.path),
    })),
  ];
  const snapshots = await Promise.all(locations.map((location) => readCanvasStore(location, { strict: true })));
  const canvasSignature = JSON.stringify(snapshots);
  for (const snapshot of snapshots) {
    if (snapshot.problems.length > 0) {
      throw new GroupProjectScopeMigrationError(`Cannot read canvas ${snapshot.location.kvDir}: ${snapshot.problems.join('; ')}`);
    }
  }
  const names = new Map(projects.map((project) => [project.id, project.name]));
  const bindings: PersistedBinding[] = [
    ...bindingsFromCanvasStores(snapshots, names),
    ...bindingManager.getAllBindings(),
  ];
  const rows: Array<{ home: Inventory; config: DurableAgentConfig; parentKey: string }> = [];
  for (const home of inventory) {
    for (const config of home.agents) {
      const parentPath = config.parentProjectPath;
      rows.push({
        home, config,
        parentKey: parentPath
          ? await checked(`Cannot identify helper parent ${parentPath}`, () => agentConfig.projectKey(parentPath))
          : home.key,
      });
    }
  }
  const keys = new Set(inventory.map((home) => home.key));
  if (keys.size !== inventory.length) throw new GroupProjectScopeMigrationError('Registered projects share an ambiguous directory identity.');
  for (const home of inventory) {
    const foreign = new Map<string, Map<string, ScopedAgent>>();
    for (const row of rows) {
      if (row.home.key === home.key || row.parentKey !== home.key || !row.config.parentAgentId || isDisposedAgent(row.config)) continue;
      let helpers = foreign.get(row.config.parentAgentId);
      if (!helpers) foreign.set(row.config.parentAgentId, helpers = new Map());
      helpers.set(row.config.id, { config: row.config, projectName: row.home.project.name });
    }
    const unreadable = new Set<string>();
    for (const connection of home.connections) {
      for (const recorded of [connection.agentProjectPath, connection.targetProjectPath]) {
        if (recorded && !keys.has(await checked(`Cannot identify ${recorded}`, () => agentConfig.projectKey(recorded)))) {
          unreadable.add(recorded);
        }
      }
    }
    const result = bindingsFromConnections(home.connections, {
      local: new Map(home.agents.map((config) => [config.id, config])),
      projectName: home.project.name, foreign, unreadable,
    }, names);
    if (result.unknown.length > 0) throw new GroupProjectScopeMigrationError(`Unverified connections in ${home.project.path}.`);
    bindings.push(...result.bindings);
  }
  const projectIds = new Map<string, Set<string>>();
  const addAgent = (agentId: string, projectId: string) => {
    let ids = projectIds.get(agentId);
    if (!ids) projectIds.set(agentId, ids = new Set());
    ids.add(projectId);
  };
  for (const row of rows) addAgent(row.config.id, row.home.project.id);
  for (const [agentId, registration] of registrations) {
    const key = await checked(`Cannot identify live agent ${agentId}`, () => agentConfig.projectKey(registration.projectPath));
    for (const home of inventory) if (home.key === key) addAgent(agentId, home.project.id);
  }
  const legacyIds = new Set(legacy.map((project) => project.id));
  const memberProjects = new Map<string, Set<string>>();
  for (const binding of bindings) {
    if (binding.targetKind !== 'group-project' || !legacyIds.has(binding.targetId)
      || isBindingRemovedByUser(binding.agentId, binding.targetId)) continue;
    const ids = projectIds.get(binding.agentId);
    if (!ids || ids.size !== 1) throw new GroupProjectScopeMigrationError(`Cannot uniquely locate member ${binding.agentId} in a registered project.`);
    let members = memberProjects.get(binding.targetId);
    if (!members) memberProjects.set(binding.targetId, members = new Set());
    for (const id of ids) members.add(id);
  }
  const removalsSignature = JSON.stringify(bindings.map((binding) => isBindingRemovedByUser(binding.agentId, binding.targetId)));
  const assertUnchanged = async (): Promise<void> => {
    let unchanged = true;
    for (const home of inventory) {
      const config = await checked(`Cannot recheck agents in ${home.project.path}`, () => agentConfig.peekDurableConfigsChecked(home.project.path, { strict: true }));
      const connections = await checked(`Cannot recheck connections in ${home.project.path}`, () => peekConnectionsChecked(home.project.path));
      const key = await checked(`Cannot recheck identity of ${home.project.path}`, () => agentConfig.projectKey(home.project.path));
      unchanged &&= config.readable && home.agentsSignature === JSON.stringify(config.agents)
        && home.connectionsSignature === JSON.stringify(connections) && home.key === key;
    }
    const canvases = await Promise.all(locations.map((location) => readCanvasStore(location, { strict: true })));
    const after = await checked('Cannot recheck registered projects', () => projectStore.list());
    if (!unchanged || canvasSignature !== JSON.stringify(canvases)
      || generation !== agentConfig.agentConfigGeneration() || bindingsVersion !== bindingManager.getVersion()
      || liveBindingsSignature !== JSON.stringify(bindingManager.getAllBindings())
      || registrationsSignature !== JSON.stringify([...agentRegistry.getAllRegistrations()])
      || removalsSignature !== JSON.stringify(bindings.map((binding) => isBindingRemovedByUser(binding.agentId, binding.targetId)))
      || signature !== projectSignature(after)) {
      throw new GroupProjectScopeMigrationError('Membership inventory changed during migration; retry at the next startup.');
    }
  };
  await assertUnchanged();
  return {
    scopes: new Map(legacy.map((project) => [
      project.id, inferLegacyGroupProjectScope([...(memberProjects.get(project.id) ?? [])]),
    ])),
    assertUnchanged,
  };
}
