/** Passive selected description metadata. No ordinary card load, scheduling, delivery or cache repair. */
import * as path from 'path';
import * as fs from 'fs';
import type { AgentCardView } from '../../../shared/dispatcher-agent-card';
import type { DisplayReceipt, DisplayValue } from '../display-settings';
import { peekMetadataFileForDisplay, peekMetadataFileForDisplaySync } from '../settings-store';
import { readOnlyWorktreeFile } from '../read-only-worktree-file';
import { captureInstructionDisplayWitness } from '../instruction-display-witness';
import { redactChangeText } from '../read-only-display-text';
import { display } from '../remote-details-presentation';
import { MAX_CARD_FIELD, NO_ANSWER_MS, parseCard, type AgentCardDeps, type AgentCardFields, type CardRecord, type CardRequestReason } from './dispatcher-agent-cards';
import { agentPagePath, memoryPaths, memorySlug, parseAgentPage, AGENT_CARD_PLACEHOLDER, AGENT_CARD_HEADING, AGENT_NOTES_HEADING } from './dispatcher-memory';
type CardRequest = NonNullable<CardRecord['request']>;

export const DISPLAY_CARD_INDEX_BYTES = 1024 * 1024;
export const DISPLAY_CARD_PREFIX_BYTES = 32 * 1024;

/** Selected safe card fields only. Metadata and private receipts are not a wire DTO. */
export interface DisplayAgentCard {
  view: AgentCardView;
  withheld: Array<'contactWhen' | 'owns'>;
  truncated: Array<'contactWhen' | 'owns'>;
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function displayRecord(raw: unknown, agentId: string, projectPath: string): Pick<CardRecord, 'page' | 'connected' | 'request'> | null {
  if (raw === 'missing') return null;
  if (raw === 'unreadable' || !record(raw) || raw.version !== 1 || !record(raw.agents)) throw new Error('card_index_unavailable');
  if (!Object.prototype.hasOwnProperty.call(raw.agents, agentId)) return null;
  const row = raw.agents[agentId];
  const norm = (p: string) => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
  if (!record(row) || typeof row.projectPath !== 'string' || row.projectPath.length > 4096 || norm(row.projectPath) !== norm(projectPath)
    || typeof row.page !== 'string' || row.page.length > 4096 || !row.page.trim() || typeof row.connected !== 'boolean') throw new Error('card_mapping_unavailable');
  const page = memorySlug(row.page);
  // The primary index is already byte-bounded. Inspect only page references
  // needed to refuse an ambiguous selected page, never unrelated card text.
  for (const [id, other] of Object.entries(raw.agents)) if (id !== agentId && record(other) && typeof other.page === 'string' && memorySlug(other.page) === page) throw new Error('card_mapping_ambiguous');
  let request: CardRequest | undefined;
  if (row.request !== undefined) {
    const r = row.request, date = (v: unknown): v is string => typeof v === 'string' && v.length <= 64 && Number.isFinite(Date.parse(v));
    if (!record(r) || !['connect', 'setup'].includes(String(r.reason)) || !date(r.at) || r.deliveredAt !== undefined && !date(r.deliveredAt)) throw new Error('card_request_unavailable');
    request = { reason: r.reason as CardRequestReason, at: r.at, ...(r.deliveredAt !== undefined && { deliveredAt: r.deliveredAt as string }) };
  }
  return { page: row.page, connected: row.connected, ...(request && { request }) };
}
function displayCardState(row: Pick<CardRecord, 'connected' | 'request'>, hasCard: boolean, now: number): Pick<AgentCardView, 'state' | 'waitingToAsk'> {
  if (!Number.isFinite(now)) throw new Error('card_clock_unavailable');
  const delivered = row.request?.deliveredAt ? Date.parse(row.request.deliveredAt) : NaN;
  const asking = row.connected && !!row.request && (!row.request.deliveredAt || now - delivered < NO_ANSWER_MS);
  const waiting = !!row.request?.deliveredAt && now - delivered < NO_ANSWER_MS;
  const state = hasCard ? 'ready' : waiting && row.connected ? 'asking' : 'none';
  return { state, ...(state === 'none' && asking && { waitingToAsk: true }) };
}

/** Reuse the existing ancestor/descriptor guard, including a genuinely missing memory root. */
function displayCardFile(memoryRoot: string, page: string) {
  const file = agentPagePath(page, memoryRoot);
  let anchor = memoryRoot;
  for (let depth = 0; ; depth++) {
    try { if (!fs.statSync(anchor).isDirectory()) throw new Error('card_root_unavailable'); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || depth >= 32 || path.dirname(anchor) === anchor) throw error;
      anchor = path.dirname(anchor);
    }
  }
  const relative = path.relative(anchor, file).split(path.sep).join('/');
  return { anchor, relative, receipt: captureInstructionDisplayWitness(anchor, relative) };
}

/** Separate closure scope: never retain the parsed index, page prefix, Notes or raw field text. */
function displayCardReceipt(deps: Pick<AgentCardDeps, 'storePath' | 'memoryRoot' | 'now'>, storePath: string, memoryRoot: string,
  agentId: string, projectPath: string, signature: string, file?: DisplayReceipt, hasCard?: boolean, stateSignature?: string): DisplayReceipt {
  return { current: () => { try {
    if (deps.storePath() !== storePath || memoryPaths(deps.memoryRoot).root !== memoryRoot) return false;
    const row = displayRecord(peekMetadataFileForDisplaySync(storePath, DISPLAY_CARD_INDEX_BYTES), agentId, projectPath);
    if (JSON.stringify(row) !== signature || file && !file.current()) return false;
    return hasCard === undefined || !!row && JSON.stringify(displayCardState(row, hasCard, deps.now?.() ?? Date.now())) === stateSignature;
  } catch { return false; } } };
}


export async function readAgentCardForDisplay(deps: Pick<AgentCardDeps, 'storePath' | 'memoryRoot' | 'now'>, agentId: string, projectPath: string, options: { receipts?: DisplayReceipt[]; authorized?: () => boolean } = {}): Promise<DisplayValue<DisplayAgentCard | null>> {
  const inputs = [{ field: 'Recorded selected agent description', source: 'primary' as const, observedAt: Date.now() }];
  const unknown = (): DisplayValue<DisplayAgentCard | null> => ({ state: 'unavailable', inputs });
  if (options.authorized && !options.authorized()) return unknown();
  if (typeof agentId !== 'string' || !agentId || agentId.length > 2048 || typeof projectPath !== 'string' || !projectPath || projectPath.length > 4096) return unknown();
  try {
    const storePath = deps.storePath(), memoryRoot = memoryPaths(deps.memoryRoot).root;
    const selected = displayRecord(await peekMetadataFileForDisplay(storePath, DISPLAY_CARD_INDEX_BYTES), agentId, projectPath);
    if (options.authorized && !options.authorized()) return unknown();
    const signature = JSON.stringify(selected);
    if (!selected) {
      const receipt = displayCardReceipt(deps, storePath, memoryRoot, agentId, projectPath, signature);
      if (options.authorized && !options.authorized() || !receipt.current()) return unknown();
      options.receipts?.push(receipt);
      return { state: 'ok', value: null, inputs };
    }
    const file = displayCardFile(memoryRoot, selected.page);
    const prefix = await readOnlyWorktreeFile(file.anchor, file.relative, DISPLAY_CARD_PREFIX_BYTES, { prefix: true });
    if (options.authorized && !options.authorized()) return unknown();
    let text: string | null = null;
    if (prefix.state === 'ok') {
      const decoded = prefix.bytes.toString('utf8');
      const lines = decoded.split('\n');
      const cardAt = lines.findIndex((line) => line.trimEnd() === AGENT_CARD_HEADING);
      const notesAt = lines.findIndex((line, index) => index > cardAt && line.trimEnd() === AGENT_NOTES_HEADING);
      if (prefix.truncated && (cardAt < 0 || notesAt < 0)) return unknown();
      // Decode only the complete card portion. A cut UTF-8 character in the
      // following Notes section cannot invalidate or leak into its fields.
      const cardBytes = notesAt >= 0 ? prefix.bytes.subarray(0, Buffer.byteLength(lines.slice(0, notesAt).join('\n'))) : prefix.bytes;
      const page = parseAgentPage(new TextDecoder('utf-8', { fatal: true }).decode(cardBytes));
      text = page.card && page.card !== AGENT_CARD_PLACEHOLDER ? page.card : null;
    } else if (prefix.state !== 'missing') return unknown();
    const withheld: DisplayAgentCard['withheld'] = [], truncated: DisplayAgentCard['truncated'] = [];
    const card: Partial<AgentCardFields> | null = text ? {} : null;
    if (text && card) {
      const parsed = parseCard(text);
      for (const field of ['contactWhen', 'owns'] as const) {
        if (!parsed[field]) continue;
        const safe = redactChangeText(parsed[field]);
        if (safe === null) { withheld.push(field); card[field] = 'Text withheld (conservative display policy)'; }
        else { card[field] = display(safe, MAX_CARD_FIELD); if (safe.length > MAX_CARD_FIELD) truncated.push(field); }
      }
    }
    const state = displayCardState(selected, !!text, (deps.now?.() ?? Date.now()));
    const receipt = displayCardReceipt(deps, storePath, memoryRoot, agentId, projectPath, signature, file.receipt, !!text, JSON.stringify(state));
    if (options.authorized && !options.authorized() || !receipt.current()) return unknown();
    options.receipts?.push(receipt);
    return { state: 'ok', value: { view: { ...state, card }, withheld, truncated }, inputs };
  } catch { return unknown(); /* telemetry-exempt: no raw memory/config/error text crosses display. */ }
}
