/**
 * What the managed-agents service keeps beside the asset catalog: part
 * descriptions and fork origins (the catalog's payloads have no room for
 * them), custom templates, and app-wide managed settings. One small JSON
 * file, written atomically and one write at a time.
 */
import * as fsp from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { getBaseDirPath } from '../base-dir';
import type { ManagedTemplate } from '../../../shared/managed-agents-types';
import { readRestartReceipt, type ManagedRestartReceipt } from './activation-receipts';

export interface PartMeta {
  description?: string;
  forkedFrom?: string;
  updatedBy?: string;
  /** The person's copy of a built-in an app update retired: the built-in's id (D99). */
  fromRetiredBuiltin?: string;
  /** A part added from a project's repository: the repository copy's hash when it was added or last updated from it. */
  projectHash?: string;
  /** A repository copy the person chose not to take (Keep mine): its hash. A later change asks again. */
  projectKeptHash?: string;
  /** A library part a person chose for a repository part with the same content: that project and key. Changes are tracked as for a project part. */
  projectLink?: { projectId: string; key: string };
}

export interface ManagedState {
  version: 1;
  parts: Record<string, PartMeta>;
  templates: Record<string, ManagedTemplate>;
  defaultHelperTemplateId?: string;
  /** Orchestrators may name a template or add and remove parts for a helper (#2899). Off unless the person turns it on. */
  helperTemplateChoice?: boolean;
  /** One-time settings migrations done for the switch away from Clubhouse Mode (D61, D63): id to when. */
  migrations?: Record<string, string>;
  /** Each retired built-in part or template and the custom copy that took its place (D99), so it is copied once. */
  retiredCopies?: Record<string, string>;
  /** A retired built-in's copy about to be made, with its name and when, so one made just before the app stopped is found again (D99). */
  retiredPending?: Record<string, { name: string; at: string }>;
  /** Latest bounded lifecycle history: ids/revisions and outcomes only, never provider content or errors. */
  restarts?: ManagedRestartReceipt[];
}

const EMPTY: ManagedState = { version: 1, parts: {}, templates: {} };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function managedStateDir(): string {
  return path.join(getBaseDirPath(), 'managed-agents');
}

export interface ManagedStateStore {
  read(): Promise<ManagedState>;
  update<T>(fn: (state: ManagedState) => T | Promise<T>): Promise<T>;
}

export function createManagedStateStore(dir: string = managedStateDir()): ManagedStateStore {
  const file = path.join(dir, 'state.json');
  let queue: Promise<unknown> = Promise.resolve();

  async function load(): Promise<ManagedState> {
    let raw: string;
    try {
      raw = await fsp.readFile(file, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return structuredClone(EMPTY);
      throw err;
    }
    let parsed: Partial<ManagedState>;
    try { parsed = JSON.parse(raw) as Partial<ManagedState>; } catch {
      throw new Error('Managed state is unreadable. Check local storage before retrying; no stored content was returned.');
    }
    if (parsed.version !== 1) throw new Error('managed state version not supported');
    return {
      version: 1,
      parts: parsed.parts && typeof parsed.parts === 'object' ? parsed.parts : {},
      templates: parsed.templates && typeof parsed.templates === 'object' ? parsed.templates : {},
      ...(typeof parsed.defaultHelperTemplateId === 'string' ? { defaultHelperTemplateId: parsed.defaultHelperTemplateId } : {}),
      ...(parsed.helperTemplateChoice === true ? { helperTemplateChoice: true } : {}),
      ...(parsed.migrations && typeof parsed.migrations === 'object' && !Array.isArray(parsed.migrations)
        ? { migrations: Object.fromEntries(Object.entries(parsed.migrations).filter((e): e is [string, string] => typeof e[1] === 'string')) }
        : {}),
      ...(isRecord(parsed.retiredCopies)
        ? { retiredCopies: Object.fromEntries(Object.entries(parsed.retiredCopies).filter((e): e is [string, string] => typeof e[1] === 'string')) }
        : {}),
      ...(isRecord(parsed.retiredPending)
        ? { retiredPending: Object.fromEntries(Object.entries(parsed.retiredPending).filter((e): e is [string, { name: string; at: string }] => isRecord(e[1]) && typeof e[1].name === 'string' && typeof e[1].at === 'string')) }
        : {}),
      ...(Array.isArray(parsed.restarts)
        ? { restarts: parsed.restarts.slice(-100).map(readRestartReceipt).filter((r): r is ManagedRestartReceipt => r !== null) }
        : {}),
    };
  }

  async function save(state: ManagedState): Promise<void> {
    await fsp.mkdir(dir, { recursive: true });
    const tmp = `${file}.${randomUUID()}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(state, null, 2), 'utf-8');
    await fsp.rename(tmp, file);
  }

  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(fn, fn);
    queue = run.catch((): undefined => undefined);
    return run;
  }

  return {
    read: () => serial(load),
    update: <T>(fn: (state: ManagedState) => T | Promise<T>) => serial(async () => {
      const state = await load();
      const result = await fn(state);
      await save(state);
      return result;
    }),
  };
}
