import type { ChatEvent, ChatEventDataMap } from '../../../shared/chat/events';
import type { ChatDetailsEvidence, ChatDetailsField, ChatDetailsValues } from '../../../shared/chat/details-evidence';
import { CHAT_DETAILS_LIST_LIMIT, isChatDetailsEvidence, isChatDetailsValue } from '../../../shared/chat/details-evidence';
import { reportedMcpToolNames } from '../../../shared/chat/provider-inventory';
import { reportedSkillNames } from '../../../shared/chat/provider-skills';
import { readProviderSkills } from '../../../shared/chat/provider-skills';
import { safeMcpErrorLine } from '../mcp-error-text';
import { display } from '../remote-details-presentation';

/** One bounded recorder per driver open, never a transcript cache. */
export class ChatDetailsRecorder {
  private snapshot: ChatDetailsEvidence | undefined;
  private turnTokens: ChatEventDataMap['turn_ended']['usage'];
  private replacingNative = false;
  constructor(private runId: string) {}
  replaceNativeSession(nativeSessionId: string, runId: string) {
    this.runId = runId;
    if (!this.snapshot) return;
    this.snapshot.runId = runId;
    if (this.snapshot.nativeSessionId === null) { this.snapshot.nativeSessionId = nativeSessionId; return; }
    this.snapshot.nativeSessionId = nativeSessionId;
    this.snapshot.values = {}; this.snapshot.observedAt = {}; this.snapshot.omitted = {};
    this.snapshot.completeFromStart = false; this.turnTokens = undefined;
    this.replacingNative = true;
  }
  observe(event: ChatEvent): void {
    if (event.type === 'session_started') {
      this.snapshot = { version: 1, runId: this.runId, agentId: event.agentId, sessionId: event.sessionId, nativeSessionId: event.data.nativeSessionId ?? null,
        providerId: event.data.provider, driver: event.data.driver, startedAt: event.ts, startSeq: event.seq, readAt: event.ts, lastSeq: event.seq - 1, completeFromStart: true, values: {}, observedAt: {}, omitted: {} };
      this.turnTokens = undefined;
    }
    const s = this.snapshot;
    if (!s || s.agentId !== event.agentId || s.sessionId !== event.sessionId || event.seq <= s.lastSeq) return;
    s.lastSeq = event.seq;
    if (this.replacingNative) { s.startedAt = event.ts; s.startSeq = event.seq; this.replacingNative = false; }
    const set = <K extends ChatDetailsField>(key: K, value: ChatDetailsValues[K]) => {
      if (value === undefined) return;
      if (!isChatDetailsValue(key, value)) { delete s.values[key]; delete s.observedAt[key]; s.omitted[key] = (s.omitted[key] ?? 0) + 1; return; }
      s.values[key] = value; s.observedAt[key] = event.ts;
    };
    const text = (x: string) => display(x, 512);
    const bounded = <T>(field: ChatDetailsField, values: readonly T[]) => { s.omitted[field] = Math.max(0, values.length - CHAT_DETAILS_LIST_LIMIT); return values.slice(0, CHAT_DETAILS_LIST_LIMIT); };
    if (event.type === 'session_started' || event.type === 'session_info') {
      const d = event.data;
      if (d.nativeSessionId && s.nativeSessionId && s.nativeSessionId !== d.nativeSessionId) {
        // A replacement native session cannot inherit the prior one's facts.
        s.values = {}; s.observedAt = {}; s.omitted = {}; s.completeFromStart = false; s.startedAt = event.ts; s.startSeq = event.seq; this.turnTokens = undefined;
      }
      if (d.nativeSessionId) s.nativeSessionId = d.nativeSessionId;
      if (d.cliVersion !== undefined) set('cliVersion', text(d.cliVersion));
      if (d.model !== undefined) set('model', d.model === null ? null : text(d.model));
      if (d.capabilities) set('capabilities', { ...s.values.capabilities, ...Object.fromEntries(Object.entries(d.capabilities).filter(([k]) => ['subagents', 'usage', 'limits'].includes(k))) } as ChatDetailsValues['capabilities']);
      if (event.type === 'session_started') set('level', event.data.level);
      else {
        const info = event.data;
        if (info.models) set('models', bounded('models', info.models).map((m) => ({ id: text(m.id), label: text(m.label) })));
        if (info.contextLimits) set('contextLimits', { effectiveTokens: info.contextLimits.effectiveTokens, compactAtTokens: info.contextLimits.compactAtTokens, reservedTokens: info.contextLimits.reservedTokens, ...(info.contextLimits.note !== undefined && { note: info.contextLimits.note === null ? null : text(info.contextLimits.note) }) });
        if (info.mcpServers) set('mcpServers', bounded('mcpServers', info.mcpServers).map((m) => ({ name: text(m.name), status: m.status, ...(m.error && { error: text(safeMcpErrorLine(m.error) ?? 'MCP connection failed') }) })));
        if (info.providerInventory !== undefined) {
          const r = info.providerInventory;
          const providerMatches = r.provider === 'claude-code' ? s.providerId === 'claude-code' : r.provider === 'copilot' && s.providerId === 'copilot-cli';
          if (providerMatches && r.driver === s.driver && r.nativeSessionId === s.nativeSessionId) {
            const previous = s.values.inventory;
            const skillNames = r.skills === undefined ? previous?.skills : reportedSkillNames(r.skills);
            const toolNames = r.mcpTools === undefined ? previous?.mcpTools : reportedMcpToolNames(r.mcpTools);
            const previousOmitted = s.omitted.inventory ?? 0;
            const omitted = (skillNames?.length ?? 0) - Math.min(skillNames?.length ?? 0, CHAT_DETAILS_LIST_LIMIT) + (toolNames?.length ?? 0) - Math.min(toolNames?.length ?? 0, CHAT_DETAILS_LIST_LIMIT);
            set('inventory', { provider: r.provider, driver: r.driver, source: r.source, nativeSessionId: r.nativeSessionId, reportedAt: event.ts,
              ...(skillNames !== undefined && { skills: skillNames === null ? null : skillNames.slice(0, CHAT_DETAILS_LIST_LIMIT).map(text), skillsReportedAt: r.skills === undefined ? previous?.skillsReportedAt : event.ts }),
              ...(toolNames !== undefined && { mcpTools: toolNames === null ? null : toolNames.slice(0, CHAT_DETAILS_LIST_LIMIT).map(text), mcpToolsReportedAt: r.mcpTools === undefined ? previous?.mcpToolsReportedAt : event.ts }) });
            s.omitted.inventory = omitted + (r.skills === undefined || r.mcpTools === undefined ? previousOmitted : 0);
          } else { delete s.values.inventory; delete s.observedAt.inventory; }
        }
        if (info.providerSkills !== undefined) {
          const report = readProviderSkills(info.providerSkills);
          if (report && report.provider === s.providerId && report.driver === s.driver && report.nativeSessionId === s.nativeSessionId && info.nativeSessionId === report.nativeSessionId) {
            set('skills', { ...report, names: report.names === null ? null : bounded('skills', report.names).map(text), reportedAt: event.ts });
          } else { delete s.values.skills; delete s.observedAt.skills; }
        }
      }
    }
    if (event.type === 'mode_changed') set('level', event.data.level);
    if (event.type === 'model_changed') { set('model', text(event.data.modelId)); set('effort', { value: event.data.effort === undefined ? null : text(event.data.effort), isDefault: event.data.effortIsDefault === true }); }
    if (event.type === 'subagent') {
      const d = event.data;
      const known = s.values.subagents ?? [];
      const old = known.find((n) => n.subagentId === d.subagentId);
      if (!old && known.length >= CHAT_DETAILS_LIST_LIMIT) { s.omitted.subagents = (s.omitted.subagents ?? 0) + 1; return; }
      const next = { ...(old ?? {}), subagentId: text(d.subagentId), name: old?.name && d.name === 'subagent' ? old.name : text(d.name), status: d.status,
        ...(d.description !== undefined && { description: text(d.description) }), ...(d.parentToolCallId !== undefined && { parentToolCallId: text(d.parentToolCallId) }), ...(d.nativeSessionId !== undefined && { nativeSessionId: text(d.nativeSessionId) }),
        ...(d.toolCount !== undefined && { toolCount: d.toolCount }), ...(d.usage && { usage: this.tokens(d.usage) }) };
      set('subagents', [...known.filter((n) => n.subagentId !== d.subagentId), next]);
    }
    if (event.type === 'turn_started') { this.turnTokens = undefined; delete s.values.turnUsage; delete s.observedAt.turnUsage; }
    if (event.type === 'usage') {
      const d = event.data;
      if (d.subagentId) return;
      if (d.tokens !== undefined || d.costUsd !== undefined) {
        set(d.scope === 'session' ? 'sessionUsage' : 'turnUsage', { ...(d.tokens && { tokens: this.tokens(d.tokens) }), ...(d.costUsd !== undefined && { costUsd: d.costUsd }), ...(d.costIsEstimate !== undefined && { costIsEstimate: d.costIsEstimate }) });
        if (d.scope === 'turn') this.turnTokens = d.tokens ? this.tokens(d.tokens) : undefined;
      }
      if (d.context) set('context', { used: d.context.used, size: d.context.size, ...(d.context.window && { window: d.context.window }) });
      if (d.limits) {
        const limits = new Map((s.values.limits ?? []).map((l) => [l.window, l]));
        const inputOmitted = Math.max(0, d.limits.length - CHAT_DETAILS_LIST_LIMIT);
        for (const l of d.limits.slice(0, CHAT_DETAILS_LIST_LIMIT)) limits.set(text(l.window), { ...limits.get(l.window), window: text(l.window), ...(l.utilization !== undefined && { utilization: l.utilization }), ...(l.status && { status: l.status }), ...(l.resetsAt !== undefined && { resetsAt: l.resetsAt }) });
        set('limits', bounded('limits', [...limits.values()]));
        s.omitted.limits = Math.max(s.omitted.limits ?? 0, inputOmitted);
      }
    }
    if (event.type === 'turn_ended') {
      const d = event.data, tokens = d.usage ?? this.turnTokens;
      if (d.usage !== undefined || d.costUsd !== undefined) set('turnUsage', { ...(tokens && { tokens: this.tokens(tokens) }), ...(d.costUsd !== undefined && { costUsd: d.costUsd }) });
      if (tokens) {
        const total = { ...s.values.turnTotal };
        for (const k of ['input', 'cachedInput', 'cacheWrite', 'output', 'reasoning'] as const) if (tokens[k] !== undefined) total[k] = (total[k] ?? 0) + tokens[k]!;
        total.total = (total.total ?? 0) + (tokens.total ?? (tokens.input ?? 0) + (tokens.output ?? 0));
        set('turnTotal', total);
      }
      this.turnTokens = undefined;
    }
  }
  private tokens(t: NonNullable<ChatEventDataMap['usage']['tokens']>) {
    const fields = ['input', 'cachedInput', 'cacheWrite', 'output', 'reasoning', 'total'] as const;
    if (!fields.every((k) => t[k] === undefined || typeof t[k] === 'number' && Number.isFinite(t[k]) && t[k]! >= 0)) return undefined;
    return Object.fromEntries(fields.filter((k) => t[k] !== undefined).map((k) => [k, t[k]]));
  }
  read(now: number): ChatDetailsEvidence | undefined {
    if (!this.snapshot) return;
    const copy = structuredClone(this.snapshot); copy.readAt = now;
    // Drop the largest field explicitly until the conservative wire budget fits.
    const valid = (value: unknown): boolean => isChatDetailsEvidence(value);
    while (!valid(copy)) {
      const field = (Object.keys(copy.values) as ChatDetailsField[]).sort((a, b) => JSON.stringify(copy.values[b]).length - JSON.stringify(copy.values[a]).length)[0];
      if (!field) return;
      copy.omitted[field] = (copy.omitted[field] ?? 0) + (Array.isArray(copy.values[field]) ? (copy.values[field] as unknown[]).length : 1);
      delete copy.values[field]; delete copy.observedAt[field];
    }
    return copy;
  }
}
