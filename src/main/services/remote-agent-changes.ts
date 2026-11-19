/** Selected-agent Changes under the existing Details read authority. No caller path/ref/session. */
import type { RemoteAgentChanges, RemoteChangesQuery } from '../../shared/remote-agent-changes';
import { isRemoteAgentChanges, isRemoteChangesQuery, REMOTE_CHANGES_MAX_BYTES } from '../../shared/remote-agent-changes';
import { isDisposedAgent } from '../../shared/agent-helpers';
import { resolveAgentConfigTarget } from './agent-config-reader';
import { agentRegistry } from './agent-registry';
import { getAgentRuntime } from './agent-runtime';
import { isAgentRunning } from './agent-system';
import { isDispatcherIdentityAgentId } from './dispatcher/dispatcher-service';
import { readOnlyGit, ReadOnlyGitError, readOnlyRepositoryRoot, readOnlyRepositoryChanges, type ReadOnlyComparison } from './read-only-repository-changes';
import { redactSecretValues } from '../telemetry/diag-redaction';
import { captureReadOnlyAgentTargetWitness } from './read-only-agent-target-witness';

const safeText = (s: string) => redactSecretValues(s).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 2048);
const inFlight = new Set<string>();
export async function readRemoteAgentChanges(agentId: string, query: RemoteChangesQuery, authorized: () => boolean): Promise<{ status: number; body: unknown }> {
  const refused = () => ({ status: 403, body: { error: 'details_read_refused' } });
  if (!authorized()) return refused();
  if (!isRemoteChangesQuery(query)) return { status: 400, body: { error: 'invalid_changes_query' } };
  if (inFlight.size >= 2 || inFlight.has(agentId)) return { status: 429, body: { error: 'changes_read_busy' } };
  inFlight.add(agentId);
  const checked = async <T>(work: Promise<T>): Promise<T> => { const value = await work; if (!authorized()) throw new Error('revoked'); return value; };
  try {
    const target = await checked(resolveAgentConfigTarget(agentId, undefined, { strict: true }));
    if (target.agent.id !== agentId || isDisposedAgent(target.agent)) return { status: 404, body: { error: 'agent_not_found' } };
    const targetWitness = isDispatcherIdentityAgentId(agentId) ? null : captureReadOnlyAgentTargetWitness(target);
    const registration = agentRegistry.get(agentId);
    const nonce = registration?.nonce;
    const runtimeKind = registration?.runtime;
    const runtime = getAgentRuntime(agentId);
    const running = isAgentRunning(agentId);
    const sessionId = runtime?.kind === 'chat' ? runtime.getSessionId?.() ?? null : null;
    const nativeSessionId = runtime?.kind === 'chat' ? runtime.getNativeSessionId?.() ?? null : null;
    const cwd = registration?.cwd || target.agent.worktreePath || target.project.path;
    const result: RemoteAgentChanges = { version: 1, readOnly: true, agentId, observedAt: Date.now(), scope: query.scope, state: 'ok', branch: null, base: null, sessionId, turnId: null, live: true, shared: false,
      files: [], totalFiles: 0, offset: query.offset ?? 0, nextOffset: null, uncompared: 0, skippedLarge: [], skippedRepos: [], skippedOmitted: 0 };
    const root = isDispatcherIdentityAgentId(agentId) ? null : await checked(readOnlyRepositoryRoot(cwd));
    let head: string | null = null;
    let comparison: ReadOnlyComparison | undefined;
    const git = async (args: string[]) => (await checked(readOnlyGit(root!, args))).toString().trim();
    const probe = async (args: string[]) => {
      try { return await git(args); }
      catch (error) { if (error instanceof ReadOnlyGitError && error.code === 1) return null; throw error; }
    };
    if (isDispatcherIdentityAgentId(agentId)) result.state = 'unsupported';
    else if (!root) result.state = 'not-git';
    else {
      head = await probe(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
      result.branch = await probe(['symbolic-ref', '--quiet', '--short', 'HEAD']) || head?.slice(0, 8) || null;
      if (query.scope === 'branch') {
        const defaultRef = await probe(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
        const names = defaultRef ? [defaultRef.replace(/^origin\//, '')] : ['main', 'master'];
        let from: string | null = null;
        for (const name of names) {
          const bases: string[] = [];
          for (const ref of [`refs/remotes/origin/${name}`, `refs/heads/${name}`]) {
            const commit = await probe(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
            if (commit && head) { const base = await probe(['merge-base', head, commit]); if (base) bases.push(base); }
          }
          if (bases.length) {
            from = bases[0];
            if (bases[1] && bases[1] !== from && await probe(['merge-base', '--is-ancestor', from, bases[1]]) !== null) from = bases[1];
            result.base = safeText(name); break;
          }
        }
        if (from) comparison = { root, from, identity: `${agentId}:${nonce ?? ''}:${query.scope}` };
        else result.state = 'no-base';
      } else if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(agentId) || agentId.includes('..') || agentId.endsWith('.') || agentId.endsWith('.lock')) result.state = 'unsupported';
      else {
        const prefix = `refs/clubhouse/checkpoints/${agentId}/`;
        const rows = (await git(['for-each-ref', '--sort=creatordate', '--count=301', '--format=%(refname)%09%(objectname)', prefix])).split('\n').filter(Boolean);
        if (rows.length > 300) throw new Error('checkpoint_inventory_limit');
        const refs = rows.map((line) => {
          const [name, commit] = line.split('\t');
          const parts = name.slice(prefix.length).split('/');
          if (!name.startsWith(prefix) || parts.length !== 3 || !/^[a-f0-9]{40,64}$/.test(commit)) throw new Error('checkpoint_inventory_invalid');
          return { sessionId: parts[0], turnId: parts[1], phase: parts[2], commit };
        });
        const starts = refs.filter((r) => r.phase === 'start' && (!sessionId || r.sessionId === sessionId));
        const selectedSession = sessionId ?? starts[starts.length - 1]?.sessionId ?? null;
        const turns = starts.filter((r) => r.sessionId === selectedSession);
        const start = query.scope === 'session' ? turns[0] : turns[turns.length - 1];
        if (!start) result.state = 'no-checkpoint';
        else {
          result.sessionId = selectedSession;
          result.turnId = query.scope === 'turn' ? start.turnId : null;
          const end = query.scope === 'turn' ? refs.find((r) => r.sessionId === selectedSession && r.turnId === start.turnId && r.phase === 'end')?.commit : undefined;
          result.live = !end;
          result.shared = refs.some((r) => r.sessionId === selectedSession && (query.scope !== 'turn' || r.turnId === start.turnId) && r.phase === 'shared');
          comparison = { root, from: start.commit, to: end, identity: `${agentId}:${nonce ?? ''}:${query.scope}:${selectedSession}:${result.turnId ?? ''}` };
          for (const commit of [start.commit, ...(end ? [end] : [])]) {
            const message = await git(['show', '-s', '--format=%B', commit]);
            for (const line of message.split('\n')) {
              const list = line.startsWith('Skipped-large: ') ? result.skippedLarge : line.startsWith('Skipped-repo: ') ? result.skippedRepos : null;
              if (!list) continue;
              try { const value: unknown = JSON.parse(line.slice(line.indexOf(': ') + 2)); if (typeof value !== 'string') throw new Error('invalid'); const label = safeText(value); if (!list.includes(label)) { if (list.length < 50) list.push(label); else result.skippedOmitted++; } }
              catch { throw new Error('checkpoint_skip_evidence_invalid'); }
            }
          }
        }
      }
      if (comparison) Object.assign(result, await checked(readOnlyRepositoryChanges(comparison, query, authorized)));
    }
    if (!authorized()) return refused();
    const finalTarget = await checked(resolveAgentConfigTarget(agentId, undefined, { strict: true }));
    if (finalTarget.agent.id !== agentId || isDisposedAgent(finalTarget.agent) || finalTarget.project.path !== target.project.path || finalTarget.agent.worktreePath !== target.agent.worktreePath
      || root && await checked(readOnlyRepositoryRoot(cwd)) !== root) return { status: 409, body: { error: 'agent_target_changed' } };
    if (root && await probe(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']) !== head) return { status: 409, body: { error: 'agent_run_or_branch_changed' } };
    const current = agentRegistry.get(agentId);
    if (current !== registration || current?.nonce !== nonce || current?.runtime !== runtimeKind || isAgentRunning(agentId) !== running
      || running && !registration && runtime?.kind !== 'chat'
      || runtime?.kind === 'chat' && (getAgentRuntime(agentId) !== runtime || runtime.getSessionId?.() !== sessionId || (runtime.getNativeSessionId?.() ?? null) !== nativeSessionId)) return { status: 409, body: { error: 'agent_run_or_branch_changed' } };
    if (!authorized()) return refused();
    // No awaits after this witness: sleeping agents have no runtime/nonce to attest continued membership.
    if (targetWitness && !targetWitness.current()) return { status: 409, body: { error: 'agent_target_changed' } };
    result.observedAt = Date.now();
    while (Buffer.byteLength(JSON.stringify(result)) > REMOTE_CHANGES_MAX_BYTES && (result.skippedLarge.length || result.skippedRepos.length)) {
      (result.skippedLarge.length >= result.skippedRepos.length ? result.skippedLarge : result.skippedRepos).pop(); result.skippedOmitted++;
    }
    if (!isRemoteAgentChanges(result, agentId, query) || Buffer.byteLength(JSON.stringify(result)) > REMOTE_CHANGES_MAX_BYTES) throw new Error('changes_contract_limit');
    return { status: 200, body: result };
  } catch (error) {
    if (!authorized()) return refused();
    return error instanceof Error && error.message === 'No registered agent matches that reference.' ? { status: 404, body: { error: 'agent_not_found' } }
      : { status: 500, body: { error: 'changes_evidence_unreadable' } };
  } finally { inFlight.delete(agentId); }
}
