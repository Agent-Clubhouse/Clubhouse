import { describe, it, expect, afterEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { SCENES } from '.';
import { playScene } from '../scene-engine';
import { useComposeCli } from './managed';
import { useWelcomeTourStore } from '../welcomeTourStore';
import { useChromeStore } from '../../../chrome/chromeStore';
import type { TourScene } from '../tour-model';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useComposeCli.setState({ cli: 0 });
});

/** Draw a scene's picture and play it with reduced motion: every step at once, its final state. */
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

describe('the scenes with pictures', () => {
  it.each(['welcome-new', 'welcome-upgrade', 'switched', 'compose', 'skills', 'updates', 'share', 'dispatcher', 'orch', 'alsonew'] as TourScene[])('%s draws and plays to the end', (scene) => {
    const root = finalState(scene);
    expect(root.querySelector('.in')).not.toBeNull();
  });

  it('compose fills every wildcard with the agent’s own value, and adds no text of its own', () => {
    const root = finalState('compose');
    const wild = Array.from(root.querySelectorAll('.wc'));
    expect(wild.map((w) => w.textContent)).toEqual(['api-builder', '.clubhouse/agents/api-builder/', 'api-builder/standby']);
    // Blocks are joined with one blank line between, in order.
    const lines = Array.from(root.querySelectorAll('.fl')).map((l) => l.querySelector('span:nth-child(2)')!.textContent);
    expect(lines.filter((l) => l === '')).toHaveLength(3);
    expect(lines.filter((l) => l?.startsWith('# '))).toEqual(['# Working in Clubhouse', '# Developer', '# Coding standards']);
  });

  it('compose shows the file each CLI reads, chosen outside the picture', () => {
    const Stage = SCENES.compose.Stage!;
    const Extra = SCENES.compose.Extra!;
    render(<div className="wt"><Extra /><Stage /></div>);
    expect(screen.getByText('CLAUDE.md')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Codex' }));
    expect(screen.getByText('AGENTS.md')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Copilot' }));
    expect(screen.getByText('.github/copilot-instructions.md')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copilot' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('updates ends with the running agent offered Restart, and the others at their next start', () => {
    const root = finalState('updates');
    expect(root.querySelector('.n-r1 .st')!.textContent).toBe('Setup changed. Restart when ready.');
    expect(root.querySelector('.n-r2 .st')!.textContent).toBe('Gets it at its next start');
    expect(root.querySelector('.n-dlg b')!.textContent).toBe('Save Coding standards for 3 agents and 1 template?');
  });

  it('share ends with reviewer’s own fork and api-builder keeping the original', () => {
    const root = finalState('share');
    expect(root.querySelector<HTMLElement>('.n-fork')!.style.left).toBe('36px');
    expect(root.querySelector('.n-cap')!.textContent).toBe('reviewer has its own copy now. api-builder keeps the original.');
    expect(root.textContent).toContain('Fork for this agent instead');
  });

  it('orch ends with every helper deleted, its task accepted, and a pull request open', () => {
    const root = finalState('orch');
    expect(Array.from(root.querySelectorAll('[class*="n-t"] .sub')).map((s) => s.textContent)).toEqual(['Accepted', 'Accepted', 'Accepted', 'Accepted']);
    expect(root.querySelectorAll('[class*="n-h"].in')).toHaveLength(0);
    expect(root.querySelector('.n-orch .st')!.textContent).toBe('Pull request open');
    expect(root.querySelector('.n-why')!.textContent).toBe('Then it deletes its helpers and tells you what landed.');
  });

  it('dispatcher ends with the schedule set up and the composer empty again', () => {
    const root = finalState('dispatcher');
    expect(root.querySelector('.n-m4')!.classList.contains('in')).toBe(true);
    expect(root.querySelector('.n-compo')!.textContent).toBe('Message the Dispatcher');
    expect(root.querySelector('.n-dots')!.classList.contains('in')).toBe(false);
  });
});

describe('scene buttons only move you', () => {
  it('Create an orchestrator opens New agent and closes the tour, creating nothing', () => {
    useWelcomeTourStore.setState({ open: true, hasProjects: true });
    const openNewAgent = vi.fn();
    useChromeStore.setState({ openNewAgent } as never);
    const Extra = SCENES.orch.Extra!;
    render(<Extra />);
    fireEvent.click(screen.getByRole('button', { name: 'Create an orchestrator' }));
    expect(openNewAgent).toHaveBeenCalledWith('durable');
    expect(useWelcomeTourStore.getState().open).toBe(false);
  });

  it('Create an orchestrator isn’t offered before there’s a project', () => {
    useWelcomeTourStore.setState({ open: true, hasProjects: false });
    const Extra = SCENES.orch.Extra!;
    render(<Extra />);
    expect(screen.queryByRole('button', { name: 'Create an orchestrator' })).toBeNull();
  });
});
