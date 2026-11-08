import { describe, expect, it } from 'vitest';
import { grantKey } from './agent-grant-changes';
import { controlFromGrantModes, controlGrantModes, defaultGrants } from './default-grants';
import { ORCHESTRATION_CONTROLS } from './orchestration-policy';

describe('the approval setting as grant modes (#2970)', () => {
  it('maps each setting to start and dispose modes', () => {
    expect(controlGrantModes('hands-off')).toEqual({ create: 'allow', dispose: 'allow' });
    expect(controlGrantModes('ask-before-start')).toEqual({ create: 'ask', dispose: 'allow' });
    expect(controlGrantModes('ask-everything')).toEqual({ create: 'ask', dispose: 'ask' });
  });

  it('round-trips every setting', () => {
    for (const control of ORCHESTRATION_CONTROLS) expect(controlFromGrantModes(controlGrantModes(control))).toBe(control);
  });

  it('reads the pair with no setting of its own as asking for both', () => {
    expect(controlFromGrantModes({ create: 'allow', dispose: 'ask' })).toBe('ask-everything');
  });

  it('gives an orchestrator\'s start and dispose grants the setting\'s modes', () => {
    const base = { dispatcher: false, helper: false, orchestrates: true, crossProject: true };
    const mode = (control: Parameters<typeof controlGrantModes>[0] | undefined, key: string) =>
      defaultGrants({ ...base, control }).find((g) => grantKey(g) === key)?.mode;
    const create = grantKey({ action: 'agent.create', target: { kind: 'project', project: 'own' } });
    const createAny = grantKey({ action: 'agent.create', target: { kind: 'project', project: 'any' } });
    const dispose = grantKey({ action: 'agent.dispose', target: { kind: 'my_helpers' } });
    expect([mode(undefined, create), mode(undefined, dispose)]).toEqual(['allow', 'allow']);
    expect([mode('ask-before-start', create), mode('ask-before-start', createAny), mode('ask-before-start', dispose)]).toEqual(['ask', 'ask', 'allow']);
    expect([mode('ask-everything', create), mode('ask-everything', dispose)]).toEqual(['ask', 'ask']);
  });
});
