import { describe, expect, it } from 'vitest';
import {
  GRANT_ACTION_LABELS, applyGrantChanges, carriedGrants, grantKey, grantRows, grantTargetLabel, normalizeGrantChanges, normalizeTemplateGrants,
  withGrantChange, withoutOwnChanges, withTemplateGrants,
} from './agent-grant-changes';
import { GRANT_ACTIONS, type Grant } from './agent-grants';
import { defaultGrants } from './default-grants';

const helperDefaults = defaultGrants({ dispatcher: false, helper: true, orchestrates: false, crossProject: false });
const has = (grants: Grant[], key: string) => grants.some((g) => grantKey(g) === key);

describe('saved grant changes (#2971)', () => {
  it('normalizes, saves and revokes an explicit cross-agent activity grant', () => {
    const change = { action: 'agent.watch', target: { kind: 'app' }, mode: 'allow' } as const;
    const saved = normalizeGrantChanges({ changes: [change] });
    expect(saved).toEqual({ changes: [change] });
    expect(applyGrantChanges(helperDefaults, saved)).toContainEqual({ ...change, source: 'user' });
    const off = withGrantChange(saved, { ...change, mode: 'off' }, helperDefaults);
    expect(applyGrantChanges(helperDefaults, off).some((g) => g.action === 'agent.watch')).toBe(false);
  });

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

describe('a template\'s layer (#2971)', () => {
  const plain = defaultGrants({ dispatcher: false, helper: false, orchestrates: false, crossProject: false });
  const msg = { action: 'agent.message' as const, target: { kind: 'connected' as const } };
  const settings = { action: 'settings.app.write' as const, target: { kind: 'app' as const } };

  it('sits between the defaults and the person\'s own changes', () => {
    const saved = { changes: [{ ...settings, mode: 'off' as const, by: 'user' as const }], template: [{ ...msg, mode: 'off' as const }, { ...settings, mode: 'allow' as const }] };
    const grants = applyGrantChanges(plain, saved);
    expect(has(grants, grantKey(msg))).toBe(false);
    // The person's Off wins over the template's Allow.
    expect(has(grants, grantKey(settings))).toBe(false);
    const rows = grantRows(plain, saved);
    expect(rows.find((r) => grantKey(r) === grantKey(msg))).toMatchObject({ mode: 'off', defaultMode: 'off', source: 'template' });
    expect(rows.find((r) => grantKey(r) === grantKey(settings))).toMatchObject({ mode: 'off', defaultMode: 'allow', source: 'user' });
  });

  it('a change back to the template\'s mode is dropped, and Reset keeps the template', () => {
    const saved = { changes: [], template: [{ ...msg, mode: 'ask' as const }] };
    expect(withGrantChange(saved, { ...msg, mode: 'ask', by: 'user' }, plain)).toEqual(saved);
    const changed = withGrantChange(saved, { ...msg, mode: 'allow', by: 'user' }, plain);
    expect(changed?.changes).toHaveLength(1);
    expect(withoutOwnChanges(changed)).toEqual(saved);
    expect(withoutOwnChanges({ changes: [{ ...msg, mode: 'off' }] })).toBeUndefined();
  });

  it('a push sets or takes away entries; the person\'s changes stay', () => {
    const own = { ...settings, mode: 'off' as const, by: 'user' as const };
    let saved = withTemplateGrants({ changes: [own] }, [{ ...msg, mode: 'off' }]);
    expect(saved).toEqual({ changes: [own], template: [{ ...msg, mode: 'off' }] });
    saved = withTemplateGrants(saved, [{ ...msg, mode: null }, { ...settings, mode: 'allow' }]);
    expect(saved).toEqual({ changes: [own], template: [{ ...settings, mode: 'allow' }] });
    // A fixed row never enters the layer.
    expect(withTemplateGrants(undefined, [{ action: 'agent.message', target: { kind: 'parent' }, mode: 'off' }])).toBeUndefined();
  });

  it('reads back a saved template layer, alone or with changes, and drops what isn\'t one', () => {
    expect(normalizeGrantChanges({ template: [{ ...msg, mode: 'off', by: 'user' }, { action: 'nope', target: { kind: 'app' }, mode: 'allow' }] }))
      .toEqual({ changes: [], template: [{ ...msg, mode: 'off' }] });
    expect(normalizeTemplateGrants([{ ...msg, mode: null }])).toEqual([]);
    expect(normalizeTemplateGrants([{ ...msg, mode: null }], true)).toEqual([{ ...msg, mode: null }]);
    expect(normalizeTemplateGrants('x')).toBeUndefined();
    // Helper control's rows never enter a template.
    expect(normalizeTemplateGrants([{ action: 'agent.create', target: { kind: 'project', project: 'own' }, mode: 'allow' }, { action: 'agent.dispose', target: { kind: 'my_helpers' }, mode: 'ask' }])).toEqual([]);
    expect(withTemplateGrants(undefined, [{ action: 'agent.dispose', target: { kind: 'my_helpers' }, mode: 'off' }])).toBeUndefined();
  });

  it('carries the template\'s and its own, its own winning, for Copy and Save as template', () => {
    expect(carriedGrants({ changes: [{ ...msg, mode: 'allow', by: 'user', at: 't' }], template: [{ ...msg, mode: 'off' }, { ...settings, mode: 'ask' }] }))
      .toEqual([{ ...msg, mode: 'allow' }, { ...settings, mode: 'ask' }]);
  });
});

describe('the Wake it target (#3215)', () => {
  const target = { kind: 'connected' as const, wakeOn: true };

  it('has its own key and label, and survives a save and read back', () => {
    expect(grantKey({ action: 'agent.wake', target })).toBe('agent.wake@connected:wake_on');
    expect(grantTargetLabel(target)).toBe('Connected agents with Wake it on');
    const saved = normalizeGrantChanges({ changes: [{ action: 'agent.wake', target, mode: 'ask' }] });
    expect(saved?.changes[0].target).toEqual(target);
  });

  it('is a default row Off can turn off and Ask first can set', () => {
    expect(has(helperDefaults, 'agent.wake@connected:wake_on')).toBe(true);
    expect(has(applyGrantChanges(helperDefaults, { changes: [{ action: 'agent.wake', target, mode: 'off' }] }), 'agent.wake@connected:wake_on')).toBe(false);
    const asked = applyGrantChanges(helperDefaults, { changes: [{ action: 'agent.wake', target, mode: 'ask' }] });
    expect(asked.find((g) => grantKey(g) === 'agent.wake@connected:wake_on')?.mode).toBe('ask');
  });
});

describe('the Dispatcher-only target (#3037)', () => {
  const target = { kind: 'connected' as const, onlyDispatcher: true };

  it('has its own key and label', () => {
    expect(grantKey({ action: 'agent.wake', target })).toBe('agent.wake@connected:dispatcher');
    expect(grantTargetLabel(target)).toBe('The Dispatcher, when connected');
  });

  it('survives a save and read back, and Off removes the default', () => {
    const saved = normalizeGrantChanges({ changes: [{ action: 'agent.wake', target, mode: 'off' }] });
    expect(saved?.changes[0].target).toEqual(target);
    expect(has(applyGrantChanges(helperDefaults, saved), 'agent.wake@connected:dispatcher')).toBe(false);
    expect(has(helperDefaults, 'agent.wake@connected:dispatcher')).toBe(true);
  });
});
