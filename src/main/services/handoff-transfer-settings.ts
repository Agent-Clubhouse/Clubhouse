import { HANDOFF_TRANSFER_DEFAULTS, validateHandoffBounds, type HandoffTransferBounds } from '../../shared/handoff-manifest';
import { createSettingsStore, type SettingsStore } from './settings-store';
import { currentSettingsOrigin, auditChanged } from './settings-audit';
import { peekProjects } from './project-store';

interface TransferSettings { v: 1; projects: Record<string, HandoffTransferBounds> }
function parse(raw: unknown): TransferSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid handoff transfer limits.');
  const value = raw as TransferSettings;
  if (value.v !== 1 || Object.keys(value).some((key) => !['v', 'projects'].includes(key)) || !value.projects
    || typeof value.projects !== 'object' || Array.isArray(value.projects) || Object.keys(value.projects).length > 1000) throw new Error('Invalid handoff transfer limits.');
  for (const [id, bounds] of Object.entries(value.projects)) {
    if (!validId(id)) throw new Error('Invalid handoff transfer project.');
    validateHandoffBounds(bounds);
  }
  return structuredClone(value);
}
function validId(id: string): boolean { return !!id && id.length <= 128 && !['__proto__', 'constructor', 'prototype'].includes(id); }
class TransferStore {
  private readonly disk: SettingsStore<TransferSettings>;
  private committed?: TransferSettings;
  private unreadable = false;
  private pending: Promise<unknown> = Promise.resolve();
  constructor() {
    this.disk = createSettingsStore<TransferSettings>('handoff-transfer-settings.json', { v: 1, projects: {} } as TransferSettings, parse, {
      atomic: true, mode: 0o600, rollBackFailedSaves: true,
      onLoad: (result) => {
        if ('error' in result) this.unreadable = (result.error as NodeJS.ErrnoException)?.code !== 'ENOENT';
        else {
          try { parse(JSON.parse(result.raw)); }
          catch { this.unreadable = true; /* telemetry-exempt: corrupt limits fail closed, without reflecting their contents */ }
        }
      },
    });
  }
  private read(): TransferSettings {
    if (!this.committed) {
      const value = this.disk.get();
      if (this.unreadable) throw new Error('Handoff transfer settings are unreadable and have not been overwritten.');
      this.committed = parse(value);
    }
    return this.committed;
  }
  get(id: string): HandoffTransferBounds {
    const projects = this.read().projects;
    return structuredClone(Object.prototype.hasOwnProperty.call(projects, id) ? projects[id] : HANDOFF_TRANSFER_DEFAULTS);
  }
  set(id: string, bounds: HandoffTransferBounds): Promise<void> {
    const work = async () => {
      const next = structuredClone(this.read()); next.projects[id] = bounds;
      const checked = parse(next);
      await this.disk.save(checked); this.committed = checked;
    };
    const result = this.pending.then(work, work); this.pending = result; return result;
  }
}
let singleton: TransferStore | undefined;
const store = () => singleton ??= new TransferStore();
async function project(id: string): Promise<void> {
  if (!validId(id) || !(await peekProjects()).some((entry) => entry.id === id)) throw new Error('Choose a registered project for handoff limits.');
}
export async function getHandoffTransferBounds(projectId: string): Promise<HandoffTransferBounds> {
  await project(projectId); return store().get(projectId);
}
export async function setHandoffTransferBounds(projectId: string, raw: unknown): Promise<HandoffTransferBounds> {
  const origin = currentSettingsOrigin();
  if (origin.surface !== 'ui' || origin.actorId) throw new Error('Only the person can change handoff transfer limits in project settings.');
  await project(projectId);
  const bounds = validateHandoffBounds(raw as HandoffTransferBounds);
  await store().set(projectId, bounds);
  await auditChanged('project', 'handoff.transfer_bounds', projectId);
  return getHandoffTransferBounds(projectId);
}
export function _resetHandoffTransferSettingsForTesting(): void { singleton = undefined; }
