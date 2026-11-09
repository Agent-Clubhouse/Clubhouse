import { describe, expect, it } from 'vitest';
import { defaultGrants } from './default-grants';
import { grantSummaryGroups, grantSummaryLine, templateGrantFacts, templateGrantSummary } from './grant-summary';

describe('what agents from a template can do through Clubhouse (#2971)', () => {
  it('reads the template\'s orchestration as the facts a new agent has', () => {
    expect(templateGrantFacts(undefined)).toEqual({ dispatcher: false, helper: false, orchestrates: false, crossProject: false, control: 'hands-off' });
    expect(templateGrantFacts({ orchestrate: true, crossProjectHelpers: true, control: 'ask-before-start' }))
      .toEqual({ dispatcher: false, helper: false, orchestrates: true, crossProject: true, control: 'ask-before-start' });
    // Cross-project helpers count only with orchestration on.
    expect(templateGrantFacts({ crossProjectHelpers: true }).crossProject).toBe(false);
  });

  it('says it in one plain line', () => {
    expect(grantSummaryLine(templateGrantFacts(undefined))).toBe('Through Clubhouse it can read and message agents it\'s connected to.');
    expect(grantSummaryLine(templateGrantFacts({ orchestrate: true })))
      .toBe('Through Clubhouse it can read and message agents it\'s connected to, and start and manage its own helpers.');
    expect(grantSummaryLine(templateGrantFacts({ orchestrate: true, crossProjectHelpers: true, control: 'ask-everything' })))
      .toBe('Through Clubhouse it can read and message agents it\'s connected to, and start and manage its own helpers in any project, asking you before starting or removing one.');
    expect(grantSummaryLine(templateGrantFacts({ orchestrate: true, control: 'ask-before-start' }))).toContain('asking you before starting one');
  });

  it('counts the template\'s own permissions', () => {
    const off = [{ action: 'agent.message' as const, target: { kind: 'connected' as const }, mode: 'off' as const }];
    expect(templateGrantSummary(undefined, off).line).toBe('Through Clubhouse it can read agents it\'s connected to.');
    const none = [...off, { action: 'agent.read' as const, target: { kind: 'connected' as const }, mode: 'off' as const }];
    expect(templateGrantSummary(undefined, none).line).toBe('Through Clubhouse it can\'t read or message the agents it\'s connected to.');
    expect(templateGrantSummary({ orchestrate: true }, none).line).toBe('Through Clubhouse it can start and manage its own helpers.');
    const extra = templateGrantSummary(undefined, [{ action: 'settings.app.write', target: { kind: 'app' }, mode: 'ask' }]);
    expect(extra.groups.find((g) => g.label === 'The app')?.actions).toContain('Change app settings (asks first)');
  });

  it('lists every default grant by target, marking Ask first', () => {
    const { groups } = templateGrantSummary({ orchestrate: true, control: 'ask-before-start' });
    const helpers = groups.find((g) => g.label === 'Its helpers');
    expect(helpers?.actions).toContain('Delete agents and remove helpers');
    expect(groups.find((g) => g.label === 'Its project')?.actions).toContain('Create agents (asks first)');
    // Nothing is left out: every default grant shows up somewhere.
    const facts = templateGrantFacts({ orchestrate: true });
    const count = grantSummaryGroups(defaultGrants(facts)).reduce((n, g) => n + g.actions.length, 0);
    expect(count).toBe(new Set(defaultGrants(facts).map((g) => `${JSON.stringify(g.target)}:${g.action}`)).size);
    expect(templateGrantSummary(undefined).groups.find((g) => g.label === 'Its helpers')).toBeUndefined();
  });
});
