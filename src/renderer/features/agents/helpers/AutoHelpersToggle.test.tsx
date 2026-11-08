import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { decideHelperAuto, resolveOrchestrationPolicy, type ResolvedOrchestrationPolicy } from '../../../../shared/orchestration-policy';
import { AutoHelpersToggle } from './OrchestrationFields';

function policy(agent: object, app: boolean, projectOff = false): ResolvedOrchestrationPolicy {
  const resolved = resolveOrchestrationPolicy({ orchestrate: true, ...agent });
  return { ...resolved, autoEffective: decideHelperAuto({ app, projectOff, policy: resolved }) };
}

const toggle = () => screen.getByTestId('auto') as HTMLElement;
const isOn = () => toggle().getAttribute('aria-checked') === 'true';

describe('AutoHelpersToggle (#2671)', () => {
  it('shows on when the app turned it on and the agent has said nothing, the case its own switch would show off', () => {
    render(<AutoHelpersToggle policy={policy({}, true)} name="a" onChange={vi.fn()} testId="auto" />);
    expect(isOn()).toBe(true);
    expect(screen.getByTestId('auto-source').textContent).toBe('Following the app setting');
    expect(screen.queryByTestId('auto-clear')).toBeNull();
  });

  it('a set switch can be cleared back to following the app', () => {
    const onChange = vi.fn();
    render(<AutoHelpersToggle policy={policy({ autoHelpers: false }, true)} name="a" onChange={onChange} testId="auto" />);
    expect(isOn()).toBe(false);
    expect(screen.getByTestId('auto-source').textContent).toBe('Set on this agent');
    fireEvent.click(screen.getByTestId('auto-clear'));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('a project\'s off shows off and locked', () => {
    render(<AutoHelpersToggle policy={policy({}, true, true)} name="a" onChange={vi.fn()} testId="auto" />);
    expect(isOn()).toBe(false);
    expect(screen.getByTestId('auto-locked').textContent).toContain('project');
  });
});
