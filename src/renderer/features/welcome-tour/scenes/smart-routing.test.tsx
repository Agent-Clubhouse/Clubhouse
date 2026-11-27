import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, cleanup, act } from '@testing-library/react';
import { SCENES } from '.';
import { playScene } from '../scene-engine';
import { useOrchestratorStore } from '../../../stores/orchestratorStore';
import { useWelcomeTourStore } from '../welcomeTourStore';
import type { TourScene } from '../tour-model';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function finalState(scene: TourScene): HTMLElement {
  vi.useFakeTimers();
  const def = SCENES[scene];
  const Stage = def.Stage!;
  const { container } = render(<div className="wt"><Stage /></div>);
  const root = container.firstElementChild as HTMLElement;
  if (def.play) playScene(root, def.play, true);
  act(() => { vi.runAllTimers(); });
  return root;
}

function setCli(ids: string[]) {
  useOrchestratorStore.setState({
    enabled: ids,
    availability: Object.fromEntries(ids.map((id) => [id, { available: true }])),
  });
}

describe('the Smart routing scene', () => {
  it('with Codex: Codex takes the easy job, nears its limit, and Claude Code takes the hard one', () => {
    setCli(['claude-code', 'codex-cli']);
    const root = finalState('smart-routing');
    expect(root.querySelector('.n-pbt')!.textContent).toBe('Near its limit, skipped');
    expect(root.querySelector('.n-hp-first .st')!.textContent).toBe('Codex, gpt-6-luna, low');
    expect(root.querySelector('.n-hp-then .st')!.textContent).toBe('Claude Code, Opus, high');
    expect(root.querySelector('.n-why')!.textContent).toBe('Each helper keeps its CLI and model, even if the limits change later.');
  });

  it('with Copilot: its plan shows as unknown and it comes last, so Claude Code goes first', () => {
    setCli(['claude-code', 'copilot-cli']);
    const root = finalState('smart-routing');
    expect(root.querySelector('.n-pb .pbar')).toBeNull();
    expect(root.querySelector('.n-pbt')!.textContent).toBe('Plan unknown, so it comes last');
    expect(root.querySelector('.n-pat')!.textContent).toBe('Near its limit, skipped');
    expect(root.querySelector('.n-hp-first .st')!.textContent).toBe('Claude Code, Haiku, low');
    expect(root.querySelector('.n-hp-then .st')!.textContent).toMatch(/^Copilot, claude-opus-5\.5, high$/);
  });
});

describe('Also new', () => {
  beforeEach(() => setCli(['claude-code']));

  it('has eight cards when Smart routing has its own scene', () => {
    useWelcomeTourStore.setState({ smartRouting: true });
    const root = finalState('alsonew');
    expect(root.querySelector('.ag')!.getAttribute('data-cards')).toBe('8');
    expect(root.textContent).not.toContain('Smart routing');
  });

  it('keeps Smart routing as a card with one CLI, nine cards in three even rows', () => {
    useWelcomeTourStore.setState({ smartRouting: false });
    const root = finalState('alsonew');
    expect(root.querySelector('.ag')!.getAttribute('data-cards')).toBe('9');
    expect(root.querySelector('.ag')!.classList.contains('nine')).toBe(true);
    expect(root.textContent).toContain('Smart routing');
  });
});
