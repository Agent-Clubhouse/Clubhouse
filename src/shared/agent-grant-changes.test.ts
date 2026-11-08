import { describe, expect, it } from 'vitest';
import {
  GRANT_ACTION_LABELS, applyGrantChanges, grantKey, grantRows, grantTargetLabel, normalizeGrantChanges, withGrantChange,
} from './agent-grant-changes';
import { GRANT_ACTIONS, type Grant } from './agent-grants';
import { defaultGrants } from './default-grants';

const helperDefaults = defaultGrants({ dispatcher: false, helper: true, orchestrates: false, crossProject: false });
const has = (grants: Grant[], key: string) => grants.some((g) => grantKey(g) === key);

describe('saved grant changes (#2971)', () => {
  it('Off removes a default, Allow and Ask first add or override one', () => {
    const changed = applyGrantChanges(helperDefaults, { changes: [
      { action: 'agent.read', target: { kind: 'connected' }, mode: 'off' },
      { action: 'settings.app.write', target: { kind: 'app' }, mode: 'allow' },
      { action: 'agent.message', target: { kind: 'connected' }, mode: 'ask' },
    ] });
    expect(has(changed, 'agent.read@connected')).toBe(false);
    expect(changed.find((g) => grantKey(g) === 'settings.app.write@app')).toMatchObject({ mode: 'allow', source: 'user' });
    expect(changed.find((g) => grantKey(g) === 'agent.message@connected')?.mode).toBe('ask');
  });

  it('a helper messaging its orchestrator is fixed: no change turns it off', () => {
    const changed = applyGrantChanges(helperDefaults, { changes: [{ action: 'agent.message', target: { kind: 'parent' }, mode: 'off' }] });
    expect(has(changed, 'agent.message@parent')).toBe(true);
    expect(grantRows(helperDefaults, undefined).find((r) => r.target.kind === 'parent')).toMatchObject({ fixed: true, mode: 'allow' });
  });

  it('setting a row back to its default drops the change', () => {
    const off = withGrantChange(undefined, { action: 'agent.read', target: { kind: 'connected' }, mode: 'off' }, helperDefaults);
    expect(off?.changes).toHaveLength(1);
    expect(withGrantChange(off, { action: 'agent.read', target: { kind: 'connected' }, mode: 'allow' }, helperDefaults)).toBeUndefined();
    expect(withGrantChange(undefined, { action: 'settings.app.write', target: { kind: 'app' }, mode: 'off' }, helperDefaults)).toBeUndefined();
  });

  it('drops anything malformed on read, never widening', () => {
    expect(normalizeGrantChanges({ changes: [
      { action: 'agent.delete', target: { kind: 'any' }, mode: 'allow' },
      { action: 'agent.read', target: { kind: 'everyone' }, mode: 'allow' },
      { action: 'agent.read', target: { kind: 'self' }, mode: 'always' },
      { action: 'agent.wake', target: { kind: 'connected' }, mode: 'allow' },
    ] })).toEqual({ changes: [{ action: 'agent.wake', target: { kind: 'connected' }, mode: 'allow' }] });
    expect(normalizeGrantChanges('nope')).toBeUndefined();
  });

  it('rows show each default once, its source and a change', () => {
    const rows = grantRows(helperDefaults, { changes: [{ action: 'settings.app.write', target: { kind: 'app' }, mode: 'allow', by: 'user' }] });
    expect(rows.find((r) => r.action === 'settings.app.write')).toMatchObject({ mode: 'allow', defaultMode: 'off', source: 'user' });
    expect(rows.find((r) => r.action === 'agent.read' && r.target.kind === 'self')).toMatchObject({ source: 'every_agent', mode: 'allow' });
    expect(new Set(rows.map(grantKey)).size).toBe(rows.length);
  });

  it('marks a row a wider Allow row covers, so its own Off would change nothing', () => {
    const orchestrator = defaultGrants({ dispatcher: false, helper: false, orchestrates: true, crossProject: true });
    const rows = grantRows(orchestrator, undefined);
    expect(rows.find((r) => r.action === 'agent.create' && r.target.kind === 'project' && r.target.project === 'own')?.coveredBy).toBe('agent.create@project:any');
    expect(rows.find((r) => r.action === 'agent.create' && r.target.kind === 'project' && r.target.project === 'any')?.coveredBy).toBeUndefined();
    // Turning the wider one off uncovers the narrower one.
    const off = grantRows(orchestrator, { changes: [{ action: 'agent.create', target: { kind: 'project', project: 'any' }, mode: 'off' }] });
    expect(off.find((r) => r.action === 'agent.create' && r.target.kind === 'project' && r.target.project === 'own')?.coveredBy).toBeUndefined();
  });

  it('rebuilds saved changes from their known fields only', () => {
    expect(normalizeGrantChanges({ changes: [{ action: 'agent.wake', target: { kind: 'connected', extra: 1 }, mode: 'allow', by: 'mallory', at: 'x', junk: true }] }))
      .toEqual({ changes: [{ action: 'agent.wake', target: { kind: 'connected' }, mode: 'allow', at: 'x' }] });
  });

  it('labels every action and target in plain words', () => {
    for (const a of GRANT_ACTIONS) expect(GRANT_ACTION_LABELS[a]).toMatch(/^[A-Z]/);
    expect(grantTargetLabel({ kind: 'parent' })).toBe('Its orchestrator');
  });
});
