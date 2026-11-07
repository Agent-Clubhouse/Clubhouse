/**
 * IPC for Clubhouse-managed agents (#2819). Every call returns a
 * ManagedResult so the renderer gets a code and plain message, never a raw
 * error. Arguments are shape-checked here; the service checks meaning.
 */
import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import type { ManagedPartContent, ManagedPartKind, ManagedResult, ManagedTemplate, ManagedTemplateSettings } from '../../shared/managed-agents-types';
import { managedAgents, restartManagedAgent, statusFor, isAgentWorking } from '../services/managed-agents';
import { applyManagedSettings, convertToManaged, createManagedAgent, previewConvert } from '../services/managed-agents/agents';
import { previewManagedSetup } from '../services/managed-agents/delivery';
import { ManagedError } from '../services/managed-agents/service';
import * as agentConfig from '../services/agent-config';
import { resolveOrchestrator } from '../services/agent-system';
import { appLog } from '../services/log-service';
import { broadcastToAllWindows } from '../util/ipc-broadcast';
import { arrayArg, booleanArg, numberArg, objectArg, stringArg, withValidatedArgs, type ArgValidator } from './validation';

const KINDS: ManagedPartKind[] = ['block', 'skill', 'mcp'];
const idArg = () => stringArg({ maxLength: 128 });
const kindArg = (): ArgValidator<ManagedPartKind> => (value, name) => {
  const v = stringArg({ maxLength: 16 })(value, name);
  if (!(KINDS as string[]).includes(v)) throw new Error(`Invalid ${name}`);
  return v as ManagedPartKind;
};
const modeArg = (): ArgValidator<'copy' | 'remove'> => (value, name) => {
  const v = stringArg({ maxLength: 16 })(value, name);
  if (v !== 'copy' && v !== 'remove') throw new Error(`Invalid ${name}`);
  return v;
};

function setupShape(value: unknown): void {
  const v = value as Record<string, unknown>;
  for (const key of ['blocks', 'skills', 'mcps']) {
    if (!Array.isArray(v[key]) || (v[key] as unknown[]).some((x) => typeof x !== 'string' || x.length > 128)) throw new Error(`Invalid setup ${key}`);
  }
  if (v.templateId !== undefined && typeof v.templateId !== 'string') throw new Error('Invalid setup templateId');
}
const setupArg = () => objectArg<{ blocks: string[]; skills: string[]; mcps: string[]; templateId?: string }>({ validate: setupShape });

function contentShape(value: unknown): void {
  const c = value as Record<string, unknown>;
  if (c.kind === 'block') {
    if (typeof c.content !== 'string') throw new Error('Invalid block content');
  } else if (c.kind === 'skill') {
    if (typeof c.skillName !== 'string' || !Array.isArray(c.files)) throw new Error('Invalid skill content');
  } else if (c.kind === 'mcp') {
    if (typeof c.serverKey !== 'string' || typeof c.transport !== 'string') throw new Error('Invalid MCP content');
  } else {
    throw new Error('Invalid part content');
  }
}

async function result<T>(fn: () => Promise<T>): Promise<ManagedResult<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    if (err instanceof ManagedError) return { ok: false, code: err.code, message: err.message === err.code ? undefined : err.message };
    // telemetry-exempt: logged; the renderer shows a fixed message.
    appLog('core:managed', 'warn', 'Managed agents call failed', { meta: { error: err instanceof Error ? err.message : String(err) } });
    return { ok: false, code: 'failed', message: err instanceof Error ? err.message : undefined };
  }
}

export function registerManagedAgentsHandlers(): void {
  const s = () => managedAgents();

  ipcMain.handle(IPC.MANAGED.LIST_PARTS, withValidatedArgs([kindArg()], (_e, kind) => result(() => s().listParts(kind))));
  ipcMain.handle(IPC.MANAGED.GET_PART, withValidatedArgs([idArg()], (_e, id) => result(() => s().getPart(id))));
  ipcMain.handle(IPC.MANAGED.CREATE_PART, withValidatedArgs(
    [objectArg<{ name: string; description?: string; content: ManagedPartContent }>({ validate: (v) => { stringArg({ maxLength: 200 })(v.name, 'name'); contentShape(v.content); } })],
    (_e, input) => result(() => s().createPart(input)),
  ));
  ipcMain.handle(IPC.MANAGED.UPDATE_PART, withValidatedArgs(
    [objectArg<{ id: string; expectedRevision: number; name?: string; description?: string; content?: ManagedPartContent }>({ validate: (v) => {
      idArg()(v.id, 'id');
      numberArg()(v.expectedRevision, 'expectedRevision');
      if (v.content !== undefined) contentShape(v.content);
    } })],
    (_e, input) => result(() => s().updatePart(input)),
  ));
  ipcMain.handle(IPC.MANAGED.FORK_PART, withValidatedArgs(
    [idArg(), objectArg<{ projectPath: string; agentId: string }>({ optional: true }), stringArg({ optional: true, maxLength: 200 })],
    (_e, id, agent, name) => result(() => s().forkPart({ id, ...(agent && { agent }), ...(name && { name }) })),
  ));
  ipcMain.handle(IPC.MANAGED.BACK_TO_SHARED, withValidatedArgs([stringArg(), idArg(), idArg()], (_e, projectPath, agentId, id) => result(() => s().backToShared({ projectPath, agentId, id }))));
  ipcMain.handle(IPC.MANAGED.DELETE_PART, withValidatedArgs(
    [idArg(), numberArg(), modeArg()],
    (_e, id, expectedRevision, mode) => result(() => s().deletePart({ id, expectedRevision, mode })),
  ));
  ipcMain.handle(IPC.MANAGED.CONSUMERS, withValidatedArgs([idArg()], (_e, id) => result(() => s().consumers(id))));

  ipcMain.handle(IPC.MANAGED.GET_SETUP, withValidatedArgs([stringArg(), idArg()], (_e, projectPath, agentId) => result(() => s().getSetup(projectPath, agentId))));
  ipcMain.handle(IPC.MANAGED.SAVE_SETUP, withValidatedArgs([stringArg(), idArg(), setupArg()], (_e, projectPath, agentId, setup) => result(() => s().saveSetup(projectPath, agentId, setup))));
  ipcMain.handle(IPC.MANAGED.UNMANAGE, withValidatedArgs([stringArg(), idArg()], (_e, projectPath, agentId) => result(() => s().unmanage(projectPath, agentId))));
  ipcMain.handle(IPC.MANAGED.PREVIEW, withValidatedArgs([stringArg(), idArg(), objectArg<{ blocks: string[]; skills: string[]; mcps: string[] }>({ optional: true, validate: setupShape })], (_e, projectPath, agentId, setup) => result(async () => {
    const agent = await agentConfig.getDurableConfig(projectPath, agentId);
    if (!agent) throw new ManagedError('not_found');
    const provider = await resolveOrchestrator(projectPath, agent.orchestrator).catch((): undefined => undefined);
    return previewManagedSetup({ service: s(), projectPath, agent, provider, ...(setup && { setup: { version: 1 as const, ...setup } }) });
  })));

  ipcMain.handle(IPC.MANAGED.LIST_TEMPLATES, withValidatedArgs([], () => result(() => s().listTemplates())));
  ipcMain.handle(IPC.MANAGED.GET_TEMPLATE, withValidatedArgs([idArg()], (_e, id) => result(() => s().getTemplate(id))));
  ipcMain.handle(IPC.MANAGED.SAVE_TEMPLATE, withValidatedArgs(
    [objectArg<Omit<ManagedTemplate, 'builtin' | 'updatedAt' | 'id'> & { id?: string }>({ validate: (v) => { stringArg({ maxLength: 200 })(v.name, 'name'); setupShape(v.setup); } })],
    (_e, input) => result(() => s().saveTemplate(input)),
  ));
  ipcMain.handle(IPC.MANAGED.DELETE_TEMPLATE, withValidatedArgs([idArg()], (_e, id) => result(() => s().deleteTemplate(id))));
  ipcMain.handle(IPC.MANAGED.TEMPLATE_FROM_AGENT, withValidatedArgs([stringArg(), idArg(), stringArg({ maxLength: 200 }), stringArg({ optional: true, maxLength: 2000 })],
    (_e, projectPath, agentId, name, description) => result(() => s().templateFromAgent(projectPath, agentId, name, description ?? ''))));
  const nextArg = () => objectArg<Pick<ManagedTemplate, 'setup' | 'settings'>>({ validate: (v) => setupShape(v.setup) });
  ipcMain.handle(IPC.MANAGED.PREVIEW_TEMPLATE_PUSH, withValidatedArgs([idArg(), nextArg()], (_e, id, next) => result(() => s().previewTemplatePush(id, next))));
  ipcMain.handle(IPC.MANAGED.PUSH_TEMPLATE, withValidatedArgs(
    [idArg(), nextArg(), arrayArg(objectArg<{ projectPath: string; agentId: string }>())],
    (_e, id, next, targets) => result(async (): Promise<{ failed: Array<{ agentId: string; message: string }> }> => {
      const results = await s().pushTemplate(id, next, targets);
      const failed: Array<{ agentId: string; message: string }> = [];
      for (const t of results) {
        if (t.failed) { failed.push({ agentId: t.agentId, message: t.failed }); continue; }
        try { await applyManagedSettings(t.projectPath, t.agentId, t.settings); }
        catch (err) { failed.push({ agentId: t.agentId, message: err instanceof Error ? err.message : String(err) }); }
      }
      return { failed };
    }),
  ));
  ipcMain.handle(IPC.MANAGED.GET_DEFAULT_HELPER_TEMPLATE, withValidatedArgs([], () => result(() => s().defaultHelperTemplateId())));
  ipcMain.handle(IPC.MANAGED.SET_DEFAULT_HELPER_TEMPLATE, withValidatedArgs([idArg()], (_e, id) => result(() => s().setDefaultHelperTemplateId(id))));
  ipcMain.handle(IPC.MANAGED.GET_HELPER_TEMPLATE_CHOICE, withValidatedArgs([], () => result(() => s().helperTemplateChoice())));
  ipcMain.handle(IPC.MANAGED.SET_HELPER_TEMPLATE_CHOICE, withValidatedArgs([booleanArg()], (_e, on) => result(() => s().setHelperTemplateChoice(on))));

  ipcMain.handle(IPC.MANAGED.CREATE_AGENT, withValidatedArgs(
    [stringArg(), objectArg<{ name: string; color: string; templateId?: string; setup?: { blocks: string[]; skills: string[]; mcps: string[] }; settings?: ManagedTemplateSettings }>({ validate: (v) => {
      stringArg({ maxLength: 200 })(v.name, 'name');
      stringArg({ maxLength: 64 })(v.color, 'color');
      if (v.setup !== undefined) setupShape(v.setup);
    } })],
    (_e, projectPath, input) => result(() => createManagedAgent(projectPath, input)),
  ));
  ipcMain.handle(IPC.MANAGED.CONVERT_AGENT, withValidatedArgs([stringArg(), idArg(), booleanArg(), stringArg({ optional: true, maxLength: 128 })],
    (_e, projectPath, agentId, keep, templateId) => result(() => convertToManaged(projectPath, agentId, { keep, ...(templateId && { templateId }) }))));
  ipcMain.handle(IPC.MANAGED.PREVIEW_CONVERT, withValidatedArgs([stringArg(), idArg()],
    (_e, projectPath, agentId) => result(() => previewConvert(projectPath, agentId))));
  ipcMain.handle(IPC.MANAGED.APPLY_SETTINGS, withValidatedArgs([stringArg(), idArg(), objectArg<ManagedTemplateSettings>()],
    (_e, projectPath, agentId, settings) => result(() => applyManagedSettings(projectPath, agentId, settings))));
  ipcMain.handle(IPC.MANAGED.STATUS, withValidatedArgs([stringArg(), idArg()], (_e, projectPath, agentId) => result(() => statusFor(projectPath, agentId))));
  ipcMain.handle(IPC.MANAGED.IS_WORKING, withValidatedArgs([idArg()], (_e, agentId) => result(() => isAgentWorking(agentId))));
  ipcMain.handle(IPC.MANAGED.RESTART, withValidatedArgs(
    [stringArg(), idArg(), objectArg<{ fresh?: boolean; whenTurnEnds?: boolean }>({ optional: true })],
    (_e, projectPath, agentId, options) => result(() => restartManagedAgent(projectPath, agentId, options ?? {})),
  ));
  ipcMain.handle(IPC.MANAGED.SET_CLUBHOUSE_FEATURES, withValidatedArgs([stringArg(), idArg(), booleanArg()],
    (_e, projectPath, agentId, on) => result(async () => {
      await agentConfig.setClubhouseFeatures(projectPath, agentId, on);
      // Every open settings page and card shows the switch: tell them, as the service does for its writes.
      broadcastToAllWindows(IPC.MANAGED.CHANGED);
    })));
}
