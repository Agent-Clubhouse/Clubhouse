/** Selected direct membership only; caller retains the strict parent inventory receipts. */
import * as fs from 'fs';
import { createHash } from 'crypto';
import type { RemoteHelperPage, RemoteHelperRow } from '../../shared/remote-helper-page';
import { REMOTE_HELPER_PAGE_SIZE } from '../../shared/remote-helper-page';
import { isDisposedAgent } from '../../shared/agent-helpers';
import { workSummary } from '../../shared/helper-work-summary';
import { resolveAgentConfigTarget, type AgentConfigTarget } from './agent-config-reader';
import { captureReadOnlyAgentTargetWitness, captureReadOnlyProjectWitness } from './read-only-agent-target-witness';
import type { HelperEntry } from './helper-index';
import type { DisplayReceipt, DisplayValue } from './display-settings';
import type { HelperStartRequestDisplay } from './helper-start-requests';
import { helperRequestText } from './remote-orchestration-card';
import { readOnlyHelperWork } from './read-only-helper-work';
import { agentDisplayState } from './agent-display-state';
import { isAgentRunning } from './agent-system';
import { agentRegistry } from './agent-registry';
import { getAgentRuntime } from './agent-runtime';
import { display } from './remote-details-presentation';
import { peekProjectsChecked } from './project-store';
const key = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const same = (a: string, b: string) => fs.realpathSync(a) === fs.realpathSync(b);
const localId = (v: unknown): v is string => typeof v === 'string' && !!v && v.length <= 200 && !v.includes('@') && !v.includes('||') && Array.from(v).every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127);

export async function readSelectedHelperPage(parent: AgentConfigTarget, helpers: HelperEntry[] | undefined, requests: DisplayValue<HelperStartRequestDisplay[]>, options: {
  offset: number; authorized(): boolean; target: DisplayReceipt; receipts: DisplayReceipt[];
}): Promise<RemoteHelperPage> {
  const check = () => { if (!options.authorized() || !options.target.current()) throw new Error('revoked or changed'); };
  check();
  const offset = options.offset;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 4096 || offset % REMOTE_HELPER_PAGE_SIZE) throw new Error('invalid helper offset');
  const page: RemoteHelperPage = { version: 1, source: 'selected-direct-helpers', state: 'unavailable', offset, next: null, total: null, liveCount: null, disposedCount: null,
    pendingCount: requests.state === 'ok' ? requests.value.length : null, rows: [], pending: [], notes: [] };
  if (requests.state === 'ok') page.pending = requests.value.map((r) => ({ key: key(r.requestId), name: helperRequestText(r.name, 'Name'), task: helperRequestText(r.task, 'Task'), warning: r.warning ? helperRequestText(r.warning, 'Warning') : null, createdAt: r.createdAt, expiresAt: r.expiresAt }));
  else page.notes.push('Pending starts unavailable; an empty queue is not inferred.');
  if (!helpers || helpers.length > 4096 || helpers.some((h) => !h?.config || h.config.parentAgentId !== parent.agent.id)) { page.notes.push('The strict selected helper inventory is unavailable or exceeds the 4096-row display limit.'); return page; }
  page.state = 'ok'; page.total = helpers.length; page.disposedCount = helpers.filter((h) => isDisposedAgent(h.config)).length; page.liveCount = page.total - page.disposedCount;
  if (offset > 0 && offset >= helpers.length) throw new Error('helper inventory changed');
  page.next = offset + REMOTE_HELPER_PAGE_SIZE < helpers.length ? offset + REMOTE_HELPER_PAGE_SIZE : null;
  const deadline = Date.now() + 2000;
  let disposedProjects: Awaited<ReturnType<typeof peekProjectsChecked>> | undefined;
  for (const entry of helpers.slice(offset, offset + REMOTE_HELPER_PAGE_SIZE)) {
    check(); const h = entry.config, disposed = isDisposedAgent(h);
    const row: RemoteHelperRow = { key: key([entry.projectPath, h.id]), name: display(h.name || 'Helper name unavailable', 240), projectName: null,
      status: disposed ? 'disposed' : h.handoff ? 'handed-off' : h.creation?.state === 'failed' ? 'failed' : h.creation?.state === 'creating' ? 'creating' : 'unknown',
      statusSource: disposed || h.handoff || h.creation ? 'saved' : 'unknown', branch: h.branch ? display(h.branch, 240) : null,
      failure: h.creation?.state === 'failed' ? 'creation' : disposed || h.creation ? null : 'unknown', disposedAt: disposed && Number.isFinite(Date.parse(h.disposedAt)) ? h.disposedAt : null,
      work: { state: 'unavailable', reason: disposed || h.creation ? 'not-applicable' : 'identity' } };
    page.rows.push(row);
    if (disposed) {
      try {
        disposedProjects ??= await peekProjectsChecked({ strict: true }); check();
        const projects = disposedProjects.readable ? disposedProjects.projects.filter((p) => same(p.path, entry.projectPath)) : [];
        if (projects.length === 1) { options.receipts.push(captureReadOnlyProjectWitness(projects[0])); row.projectName = display(projects[0].displayName || projects[0].name, 240); }
      } catch { /* telemetry-exempt: disposed project display stays unavailable without a unique strict association. */ check(); }
      page.notes.push('Disposed rows show saved selected-parent records; current runtime and Open are not inferred.'); continue;
    }
    try {
      const helper = await resolveAgentConfigTarget(h.id, undefined, { strict: true }); check();
      if (!localId(h.id) || !localId(helper.project.id) || helper.agent.id !== h.id || JSON.stringify(helper.agent) !== JSON.stringify(h)
        || h.parentAgentId !== parent.agent.id || !same(helper.project.path, entry.projectPath)
        || !same(h.parentProjectPath || entry.projectPath, parent.project.path)) continue;
      const witness = captureReadOnlyAgentTargetWitness(helper); options.receipts.push(witness);
      row.projectName = display(helper.project.displayName || helper.project.name || 'Project name unavailable', 240);
      row.target = { agentId: h.id, projectId: helper.project.id };
      const observe = () => {
        const reg = agentRegistry.get(h.id), running = isAgentRunning(h.id), runtime = getAgentRuntime(h.id);
        const bound = !!reg && reg.projectPath === helper.project.path && (reg.cwd || reg.projectPath) === (h.worktreePath || helper.project.path) && (!runtime || runtime.kind === reg.runtime);
        return { reg, runtime, running, bound, lifecycle: bound ? agentDisplayState(h, running) : null,
          chat: bound && runtime?.kind === 'chat' ? runtime.getState() : null };
      };
      const observed = observe(), signature = key({ running: observed.running, bound: observed.bound, lifecycle: observed.lifecycle, chat: observed.chat });
      options.receipts.push({ current: () => { try { const now = observe(); return witness.current() && now.reg === observed.reg && now.runtime === observed.runtime && key({ running: now.running, bound: now.bound, lifecycle: now.lifecycle, chat: now.chat }) === signature; } catch { return false; } } });
      if (!h.handoff && !h.creation) {
        if (observed.bound && observed.lifecycle) {
          row.statusSource = 'current-run'; row.failure = observed.lifecycle.status === 'error' || observed.chat === 'error' ? 'runtime' : null;
          row.status = row.failure ? 'failed' : observed.chat === 'waiting_permission' || observed.chat === 'waiting_input' ? 'needs-you' : observed.running ? 'running' : observed.lifecycle.status === 'waking' || observed.lifecycle.status === 'spawning' ? 'waking' : 'not-running';
        } else { row.status = observed.running ? 'unknown' : 'not-running'; row.failure = 'unknown'; }
      }
      if (!h.creation) {
        if (Date.now() >= deadline) row.work = { state: 'unavailable', reason: 'admission-limit' };
        else {
          const work = await readOnlyHelperWork(parent, entry, options.authorized); check();
          row.work = work.error ? { state: 'unavailable', reason: 'read-failed' } : { state: 'recorded', text: workSummary(work) || 'Work not reported' };
        }
      }
    } catch { // telemetry-exempt: no helper paths, raw errors or lookup references leave this display.
      check(); row.target = undefined; row.projectName = null; row.work = { state: 'unavailable', reason: 'identity' };
    }
  }
  page.notes = [...new Set(page.notes)];
  page.notes.push('Only eight direct selected helpers per page. Pages are separate current observations in strict host inventory order; work checks have a two-second admission budget, not a hard I/O deadline.');
  page.notes.push('Runtime failure and Needs you require a current registration bound to the exact helper project. Otherwise the runtime outcome is unknown; no sleeping or successful-start claim is inferred.');
  check(); return page;
}
