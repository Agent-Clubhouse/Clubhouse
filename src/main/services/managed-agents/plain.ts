/**
 * Switch to plain (#2927, D98): the counterpart of Switch to managed.
 * Clubhouse stops writing the agent's setup at each start, and the files it
 * last wrote stay in its folder as the person's. The instructions file and
 * the MCP file from before managed can come back, never over later edits:
 * what was added since Clubhouse wrote them is carried into the file that
 * comes back, and the preview shows the result before anything changes.
 */
import { createHash, randomUUID } from 'crypto';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { DurableAgentConfig, McpServerDef } from '../../../shared/types';
import type { ManagedPlainChoice, ManagedPlainPreview } from '../../../shared/managed-agents-types';
import type { OrchestratorProvider } from '../../orchestrators/types';
import { lineDiff, lineDiffTooLarge } from '../../../shared/line-diff';
import { skillsFolderOf } from '../../../shared/skills-folder';
import { appLog } from '../log-service';
import { ManagedError, type ManagedAgentsService } from './service';
import { beforeManagedDir, firstStartName } from './before-managed';
import { mcpBackupPath } from './mcp-backup';
import { EXCLUDES_MANIFEST, instructionsFileRel, mcpServersOf, renderManagedInstructions, resolveManagedSetup, SKILLS_MANIFEST } from './delivery';

/** The key the Clubhouse bridge has in every JSON MCP file. Every start writes it again, managed or not (D69). */
const BRIDGE_KEY = 'clubhouse';

export interface PlainDeps {
  service: ManagedAgentsService;
  getAgent(projectPath: string, agentId: string): Promise<DurableAgentConfig | null>;
  providerFor(projectPath: string, agent: DurableAgentConfig): Promise<OrchestratorProvider>;
  /** The instructions this app run wrote for the agent's last start, if any (D79). */
  deliveredInstructions(agentId: string): string | undefined;
}

async function readOr(file: string): Promise<string | null> {
  try {
    return await fsp.readFile(file, 'utf-8');
  } catch {
    // telemetry-exempt: no such file
    return null;
  }
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The newest file in `dir` whose name matches, by modification time. */
async function newest(dir: string, matches: RegExp): Promise<string | null> {
  let names: string[];
  try {
    names = (await fsp.readdir(dir)).filter((n) => matches.test(n));
  } catch {
    // telemetry-exempt: no folder, so no copy
    return null;
  }
  let best: { file: string; at: number } | null = null;
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const st = await fsp.stat(file);
      if (st.isFile() && (!best || st.mtimeMs >= best.at)) best = { file, at: st.mtimeMs };
    } catch { /* telemetry-exempt: gone meanwhile */ }
  }
  return best?.file ?? null;
}

/** For showing a path in app data: from ~ when it's under the home folder. */
function shown(abs: string): string {
  const home = os.homedir();
  return abs.startsWith(home + path.sep) ? `~${abs.slice(home.length)}`.replace(/\\/g, '/') : abs;
}

/** Line endings made plain, so a file saved with CRLF compares line by line with what Clubhouse wrote. */
const lf = (text: string) => text.replace(/\r\n/g, '\n');

/**
 * Runs of lines in `now` that none of `written` has: what was added since
 * Clubhouse wrote the file. Of the texts Clubhouse may have written (the
 * last delivery, the current setup), the one that leaves the fewest added
 * lines is taken. Runs of blank lines alone don't count. Line endings don't
 * matter. Null when the files differ too much to match lines up (the line
 * diff would call every line added), so nothing is guessed.
 */
export function linesAddedSince(written: string[], now: string): string[][] | null {
  let best: string[][] | null = null;
  const count = (runs: string[][]) => runs.reduce((n, r) => n + r.length, 0);
  const current = lf(now);
  for (const text of written.map(lf)) {
    if (lineDiffTooLarge(text, current)) continue;
    const runs: string[][] = [];
    let run: string[] = [];
    for (const line of lineDiff(text, current)) {
      if (line.kind === 'yours') { run.push(line.text); continue; }
      if (run.length > 0) { runs.push(run); run = []; }
    }
    if (run.length > 0) runs.push(run);
    const kept = runs.map(trimBlank).filter((r) => r.length > 0);
    if (!best || count(kept) < count(best)) best = kept;
  }
  return best;
}

function trimBlank(lines: string[]): string[] {
  let a = 0;
  let b = lines.length;
  while (a < b && !lines[a].trim()) a++;
  while (b > a && !lines[b - 1].trim()) b--;
  return lines.slice(a, b);
}

/** The earlier file with the added runs after it, each separated by a blank line, in the earlier file's line endings. */
export function withAddedLines(before: string, runs: string[][]): string {
  if (runs.length === 0) return before;
  const eol = before.includes('\r\n') ? '\r\n' : '\n';
  return `${before.replace(/\s+$/, '')}${eol}${eol}${runs.map((r) => r.join(eol)).join(eol + eol)}${eol}`;
}

type JsonObject = Record<string, unknown>;

function parseMcp(raw: string): { doc: JsonObject; servers: Record<string, McpServerDef> } | null {
  try {
    const doc = JSON.parse(raw) as unknown;
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null;
    const servers = (doc as JsonObject).mcpServers ?? {};
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return null;
    return { doc: doc as JsonObject, servers: servers as Record<string, McpServerDef> };
  } catch {
    // telemetry-exempt: not JSON; the caller says so
    return null;
  }
}

interface PlainState {
  agent: DurableAgentConfig;
  provider: OrchestratorProvider;
  worktree: string;
  preview: ManagedPlainPreview;
  /** What to write when the person brings an earlier file back. */
  instructionsResult: string | null;
  mcpResult: string | null;
  manifests: string[];
}

async function readState(deps: PlainDeps, projectPath: string, agentId: string): Promise<PlainState> {
  const agent = await deps.getAgent(projectPath, agentId);
  if (!agent) throw new ManagedError('not_found');
  if (!agent.managed) throw new ManagedError('not_managed', `${agent.name} is already plain.`);
  if (!agent.worktreePath) throw new ManagedError('invalid', `${agent.name} works in the project folder.`);
  const worktree = agent.worktreePath;
  const provider = await deps.providerFor(projectPath, agent);
  const conv = provider.conventions;
  const resolved = await resolveManagedSetup(deps.service, agent.managed, agent.id);

  // ── Instructions ──
  let instrNow: string | null = null;
  try { instrNow = await provider.readInstructions(worktree); } catch { /* telemetry-exempt: no instructions file */ }
  const written = [await renderManagedInstructions(projectPath, agent, resolved)];
  const delivered = deps.deliveredInstructions(agent.id);
  if (delivered !== undefined && delivered !== written[0]) written.push(delivered);
  const base = path.basename(conv.legacyInstructionsFile || 'instructions.md');
  const copyName = new RegExp(`^(${escape(base)}|${escape(firstStartName(base))})(\\.\\d+(-\\d+)?)?$`);
  const instrCopy = await newest(beforeManagedDir(agent.id), copyName);
  const instrBefore = instrCopy ? await readOr(instrCopy) : null;
  const changedSince = instrNow !== null && !written.map(lf).includes(lf(instrNow));
  const added = instrNow !== null && changedSince ? linesAddedSince(written, instrNow) : [];
  const instructionsResult = instrBefore !== null && added !== null ? withAddedLines(instrBefore, added) : null;
  const instructionsNote = instrCopy && added === null
    ? `${instructionsFileRel(provider)} changed too much since Clubhouse wrote it to tell which lines were added, so the earlier file can't come back here without losing them. It is kept at ${shown(instrCopy)}.`
    : undefined;

  // ── MCP file (JSON-format CLIs; Codex gets its servers as launch flags) ──
  let mcp: ManagedPlainPreview['mcp'] = null;
  let mcpResult: string | null = null;
  let mcpNowRaw: string | null = null;
  let mcpCopyRaw: string | null = null;
  if (conv.settingsFormat !== 'toml' && conv.mcpConfigFile) {
    mcpNowRaw = await readOr(path.join(worktree, conv.mcpConfigFile));
    const now = mcpNowRaw === null ? { doc: {}, servers: {} } : parseMcp(mcpNowRaw);
    const own = new Set([...Object.keys(mcpServersOf(resolved)), BRIDGE_KEY]);
    const nowKeys = now ? Object.keys(now.servers) : [];
    const addedServers = nowKeys.filter((k) => !own.has(k));
    const backupRel = mcpBackupPath(conv);
    const copy = await newest(path.dirname(path.join(worktree, backupRel)), new RegExp(`^${escape(path.basename(backupRel))}(\\.\\d+)?$`));
    const copyRaw = copy ? await readOr(copy) : null;
    mcpCopyRaw = copyRaw;
    const earlier = copyRaw !== null ? parseMcp(copyRaw) : null;
    let note: string | undefined;
    let before: NonNullable<ManagedPlainPreview['mcp']>['before'] = null;
    const copyShown = copy ? path.relative(worktree, copy).replace(/\\/g, '/') : '';
    if (copyRaw !== null && !now) {
      note = `The MCP file in its folder isn't valid JSON, so Clubhouse can't tell which servers were added since. Fix it to bring back the earlier one, which is kept at ${copyShown}.`;
    } else if (copyRaw !== null && !earlier) {
      note = `The MCP file from before managed isn't valid JSON, so it can't come back here. It is kept at ${copyShown}.`;
    } else if (copyRaw !== null && earlier && now) {
      const merged: Record<string, McpServerDef> = { ...earlier.servers };
      for (const k of addedServers) merged[k] = now.servers[k];
      mcpResult = addedServers.length === 0 ? copyRaw : `${JSON.stringify({ ...earlier.doc, mcpServers: merged }, null, 2)}\n`;
      before = { copy: copyShown, servers: Object.keys(earlier.servers).filter((k) => k !== BRIDGE_KEY), result: Object.keys(merged).filter((k) => k !== BRIDGE_KEY) };
    }
    mcp = {
      file: conv.mcpConfigFile.replace(/\\/g, '/'),
      exists: mcpNowRaw !== null,
      servers: nowKeys.filter((k) => k !== BRIDGE_KEY),
      added: addedServers,
      before,
      ...(note && { note }),
    };
  }

  // ── Clubhouse's own bookkeeping, and the skill folders that stay ──
  const skillsRel = skillsFolderOf(conv);
  const manifests: string[] = [];
  let skills: string[] = [];
  for (const rel of [skillsRel, ...(conv.previousSkillsRoots ?? [])]) {
    const raw = await readOr(path.join(worktree, rel, SKILLS_MANIFEST));
    if (raw === null) continue;
    manifests.push(path.join(rel, SKILLS_MANIFEST));
    try {
      const listed = (JSON.parse(raw) as { skills?: unknown }).skills;
      if (Array.isArray(listed)) skills = [...skills, ...listed.filter((n): n is string => typeof n === 'string' && n === path.basename(n)).map((n) => `${rel.replace(/\\/g, '/')}/${n}/`)];
    } catch { /* telemetry-exempt: a manifest cut short lists nothing */ }
  }
  let excludesAdded = 0;
  const excludesRaw = await readOr(path.join(worktree, EXCLUDES_MANIFEST));
  if (excludesRaw !== null) {
    try {
      const entries = (JSON.parse(excludesRaw) as { entries?: unknown }).entries;
      excludesAdded = Array.isArray(entries) ? entries.length : 0;
    } catch { /* telemetry-exempt: removed as Clubhouse's own anyway */ }
  }

  // Everything the switch would write, and what it was worked out from: a setup or file change since the preview refuses it.
  const token = createHash('sha256').update(JSON.stringify([instrNow, instrCopy, instrBefore, instructionsResult, mcpNowRaw, mcp?.before?.copy ?? null, mcpCopyRaw, mcpResult])).digest('hex').slice(0, 32);
  return {
    agent, provider, worktree, instructionsResult, mcpResult, manifests,
    preview: {
      instructions: {
        file: instructionsFileRel(provider),
        exists: instrNow !== null,
        changedSince,
        addedLines: (added ?? []).reduce((n, r) => n + r.length, 0),
        before: instrCopy && instructionsResult !== null ? { copy: shown(instrCopy), result: instructionsResult } : null,
        ...(instructionsNote && { note: instructionsNote }),
      },
      mcp,
      skills: [...new Set(skills)].sort(),
      excludesAdded,
      token,
    },
  };
}

/** What switching to plain leaves in the agent's folder, and what can come back. Writes nothing. */
export async function previewSwitchToPlain(deps: PlainDeps, projectPath: string, agentId: string): Promise<ManagedPlainPreview> {
  return (await readState(deps, projectPath, agentId)).preview;
}

const reason = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Write through a temporary file and a rename. The MCP file can hold env
 * values, so the temporary file never stays behind in the worktree, where it
 * would be untracked and could be committed: it is removed if the write or the
 * rename fails (on Windows a rename over an open file can).
 */
async function writeAtomically(file: string, content: string): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${randomUUID().slice(0, 8)}`;
  try {
    await fsp.writeFile(tmp, content, 'utf-8');
    await fsp.rename(tmp, file);
  } catch (err) {
    // telemetry-exempt: rethrown to the caller, which reports it to the person
    await fsp.rm(tmp, { force: true }).catch(() => { /* telemetry-exempt: the rethrown error says what failed */ });
    throw err;
  }
}

/**
 * Switch a managed agent to plain. Refused when its files changed since the
 * preview the person saw (`choice.token`). The agent's setup is cleared first
 * (its id, history, branch and wires stay, and its parts and templates are
 * left alone), then the earlier files come back as chosen.
 */
export async function switchToPlain(deps: PlainDeps, projectPath: string, agentId: string, choice: ManagedPlainChoice): Promise<void> {
  const state = await readState(deps, projectPath, agentId);
  const { agent, provider, worktree, preview } = state;
  if (!choice.token) throw new ManagedError('invalid', `Switch to plain shows ${agent.name}'s files first. Open it again.`);
  if (choice.token !== preview.token) {
    throw new ManagedError('stale', `${agent.name}'s files changed since you opened this. Look at them again before switching.`);
  }
  if (choice.restoreInstructions && !preview.instructions.before) throw new ManagedError('invalid', `Clubhouse kept no instructions file from before ${agent.name} was managed.`);
  if (choice.restoreMcp && !preview.mcp?.before) throw new ManagedError('invalid', preview.mcp?.note ?? `Clubhouse kept no MCP file from before ${agent.name} was managed.`);

  await deps.service.unmanage(projectPath, agentId);

  const failures: string[] = [];
  // The skill folders are the person's now: Clubhouse's list of what it wrote comes out.
  for (const rel of state.manifests) {
    // telemetry-exempt: collected and reported to the person below, with the reason.
    await fsp.rm(path.join(worktree, rel), { force: true }).catch((err: unknown) => { failures.push(`Its skills list ${rel} couldn't be removed (${reason(err)}).`); });
  }
  if (choice.restoreInstructions && state.instructionsResult !== null) {
    try {
      await provider.writeInstructions(worktree, state.instructionsResult);
    } catch (err) {
      // telemetry-exempt: collected and reported to the person below, with the reason.
      failures.push(`Its earlier instructions file couldn't be written (${reason(err)}). The copy is still at ${preview.instructions.before!.copy}.`);
    }
  }
  if (choice.restoreMcp && state.mcpResult !== null && provider.conventions.mcpConfigFile) {
    try {
      await writeAtomically(path.join(worktree, provider.conventions.mcpConfigFile), state.mcpResult);
    } catch (err) {
      // telemetry-exempt: collected and reported to the person below, with the reason.
      failures.push(`Its earlier MCP file couldn't be written (${reason(err)}). The copy is still at ${preview.mcp!.before!.copy}.`);
    }
  }
  appLog('core:managed', 'info', 'Switched a managed agent to plain', {
    meta: { agentId, instructions: !!choice.restoreInstructions, mcp: !!choice.restoreMcp, addedLines: preview.instructions.addedLines, addedServers: preview.mcp?.added.length ?? 0, failures: failures.length },
  });
  if (failures.length > 0) {
    throw new ManagedError('failed', `${agent.name} is plain now. ${failures.join(' ')}`);
  }
}
