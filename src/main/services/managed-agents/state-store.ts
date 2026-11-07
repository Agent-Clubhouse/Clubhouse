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

export interface PartMeta {
  description?: string;
  forkedFrom?: string;
  updatedBy?: string;
}

export interface ManagedState {
  version: 1;
  parts: Record<string, PartMeta>;
  templates: Record<string, ManagedTemplate>;
  defaultHelperTemplateId?: string;
  /** Orchestrators may name a template or add and remove parts for a helper (#2899). Off unless the person turns it on. */
  helperTemplateChoice?: boolean;
}

const EMPTY: ManagedState = { version: 1, parts: {}, templates: {} };

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
    const parsed = JSON.parse(raw) as Partial<ManagedState>;
    if (parsed.version !== 1) throw new Error('managed state version not supported');
    return {
      version: 1,
      parts: parsed.parts && typeof parsed.parts === 'object' ? parsed.parts : {},
      templates: parsed.templates && typeof parsed.templates === 'object' ? parsed.templates : {},
      ...(typeof parsed.defaultHelperTemplateId === 'string' ? { defaultHelperTemplateId: parsed.defaultHelperTemplateId } : {}),
      ...(parsed.helperTemplateChoice === true ? { helperTemplateChoice: true } : {}),
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
