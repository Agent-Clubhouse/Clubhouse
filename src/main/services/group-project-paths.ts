/**
 * Where group project data lives on disk. Only the store modules behind the
 * host service (group-project-host.ts) write here (#3356).
 */
import * as path from 'path';
import { app } from 'electron';

export function groupProjectsDir(): string {
  const dirName = app.isPackaged ? '.clubhouse' : '.clubhouse-dev';
  return path.join(app.getPath('home'), dirName, 'group-projects');
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Group project ids become directory names; refuse anything that could leave the data directory. */
export function assertGroupProjectId(id: string): void {
  if (!SAFE_ID.test(id)) throw new Error('Invalid group project id.');
}

export function groupProjectDir(id: string): string {
  assertGroupProjectId(id);
  return path.join(groupProjectsDir(), id);
}

export const registryPath = (): string => path.join(groupProjectsDir(), 'registry.json');
export const tombstonesPath = (): string => path.join(groupProjectsDir(), 'tombstones.json');
export const bulletinPath = (id: string): string => path.join(groupProjectDir(id), 'bulletin.json');
export const membershipPath = (id: string): string => path.join(groupProjectDir(id), 'membership.json');
export const hostStatePath = (id: string): string => path.join(groupProjectDir(id), 'host.json');
/** A copy of a group project hosted on another computer: when it last caught up (#3363). */
export const replicaStatePath = (id: string): string => path.join(groupProjectDir(id), 'replica.json');
/** Writes made here for other computers' group projects, waiting for their hosts. */
export const networkOutboxPath = (): string => path.join(groupProjectsDir(), 'network-outbox.json');
/** Copies this computer dropped, so a late answer from their host can't bring them back (#3363). */
export const replicaTombstonesPath = (): string => path.join(groupProjectsDir(), 'replica-tombstones.json');
/** What this computer, as host, answered other computers' writes: a replayed write gets the same answer. */
export const networkAppliedPath = (): string => path.join(groupProjectsDir(), 'network-applied.json');
/** Writes a host refused, for their authors. */
export const networkRefusalsPath = (): string => path.join(groupProjectsDir(), 'network-refusals.json');
