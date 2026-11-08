import { beforeEach, describe, expect, it, vi } from 'vitest';

const events = vi.hoisted(() => [] as Array<{ name: string; attrs: Array<{ key: string; value: unknown }>; opts: Record<string, unknown> }>);
vi.mock('../telemetry/facade', () => ({
  tel: { event: (name: string, attrs: Array<{ key: string; value: unknown }>, opts: Record<string, unknown>) => { events.push({ name, attrs, opts }); } },
}));

import { recordConnectionChange, recordGrantChange, recordGrantDecision, recordGrantRequest, toolPart } from './grant-telemetry';
import { withSettingsSurface } from './settings-audit';

const attrsOf = (i = 0) => Object.fromEntries(events[i].attrs.map((a) => [a.key, a.value]));

beforeEach(() => { events.length = 0; });

describe('Clubhouse permissions in the telemetry record (#2973)', () => {
  it('a refused call: enums and the caller\'s hash as attributes, the built-in tool name in the detail', () => {
    recordGrantDecision({ agentId: 'agent-1', toolName: 'clubhouse__my-project_reviewer_a1b2c3__clear_agent', decision: 'refused', reason: 'no_grant', actions: ['agent.reset'], targetKind: 'agent' });
    expect(events[0].name).toBe('clubhouse.audit.grant_decision');
    expect(attrsOf()).toMatchObject({
      'clubhouse.grant.decision': 'refused', 'clubhouse.grant.refusal_reason': 'no_grant',
      'clubhouse.grant.action': 'agent.reset', 'clubhouse.grant.target_kind': 'agent', 'clubhouse.audit.actor.id_hash': 'agent-1',
    });
    // Never the agent's name from the tool name.
    expect(events[0].opts.detail).toEqual({ tool: 'clear_agent' });
    expect(events[0].opts.severity).toBe('warn');
  });

  it('a call held for the user lists every asked action', () => {
    recordGrantDecision({ agentId: 'a', toolName: 'set_helper_presets', decision: 'asked', reason: 'ask_first', actions: ['settings.app.write', 'models.read'] });
    expect(attrsOf()).toMatchObject({ 'clubhouse.grant.decision': 'asked', 'clubhouse.grant.action': 'settings.app.write' });
    expect(events[0].opts.detail).toEqual({ tool: 'set_helper_presets', actions: ['settings.app.write', 'models.read'] });
  });

  it('a plugin\'s tool is never named', () => {
    expect(toolPart('plugin__acme__deploy_now')).toBe('other');
    expect(toolPart('Weird Name')).toBe('other');
  });

  it('answers and expiries', () => {
    recordGrantRequest({ agentId: 'a', kind: 'grant', outcome: 'expired', actions: ['settings.app.write'] });
    expect(events[0].name).toBe('clubhouse.audit.grant_request');
    expect(attrsOf()).toMatchObject({ 'clubhouse.grant.request.kind': 'grant', 'clubhouse.grant.request.outcome': 'expired' });
  });

  it('a change says who, from which surface, on which layer', async () => {
    await withSettingsSurface('ui', undefined, async () => {
      recordGrantChange({ agentId: 'a', layer: 'own', mode: 'allow', action: 'settings.app.write', target: { kind: 'app' } });
    });
    expect(events[0].name).toBe('clubhouse.audit.grant_change');
    expect(attrsOf()).toMatchObject({
      'clubhouse.audit.surface': 'ui', 'clubhouse.grant.change.layer': 'own', 'clubhouse.grant.change.mode': 'allow', 'clubhouse.audit.target.id_hash': 'a',
    });
    expect(events[0].opts.detail).toEqual({ target: 'app', action: 'settings.app.write' });
  });

  it('a connection change hashes the other end and lists only tool names; a migration is the system\'s', () => {
    recordConnectionChange({ fromAgentId: 'a', toAgentId: 'b', disabledTools: ['clear_agent', 'not a tool name!'], migrated: true });
    expect(attrsOf()).toMatchObject({ 'clubhouse.audit.surface': 'system', 'clubhouse.grant.change.layer': 'connection', 'clubhouse.grant.change.mode': 'off' });
    expect(events[0].opts.detail).toEqual({ target: 'connection', disabled: ['clear_agent'], migrated: true });
    expect(events[0].opts.detailIds).toEqual({ to: ['b'] });
  });
});
