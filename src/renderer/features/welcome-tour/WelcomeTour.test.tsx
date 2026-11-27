import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { act, render, screen, fireEvent, cleanup } from '@testing-library/react';
import { WelcomeTour, USER_NAVIGATION_WINDOW_MS } from './WelcomeTour';
import { openWelcomeTour, startWelcomeTourIfDue, useWelcomeTourStore } from './welcomeTourStore';
import { findHelpTopic, HELP_LINKS, LINKS_WITHOUT_STAND_IN, openHelpLink } from './tour-actions';
import { SCENES } from './scenes';
import { playScene } from './scene-engine';
import { useChromeFlagStore } from '../../chrome/chromeFlag';
import { useProjectStore } from '../../stores/projectStore';
import { useUIStore } from '../../stores/uiStore';
import { useAgentStore } from '../../stores/agentStore';
import { useOrchestratorStore } from '../../stores/orchestratorStore';
import { WELCOME_TOUR_VERSION, type WelcomeTourState } from '../../../shared/welcome-tour';

const app = () => window.clubhouse.app as unknown as Record<string, unknown>;

let saved: WelcomeTourState[];
let stored: { state: WelcomeTourState; unreadable: boolean };

function seed(state: Partial<WelcomeTourState> = {}, unreadable = false) {
  stored = { state: { seenVersion: 0, variant: null, variantVersion: 0, ...state }, unreadable };
}

beforeEach(() => {
  saved = [];
  seed();
  Object.assign(window.clubhouse.app, {
    getWelcomeTour: vi.fn(async () => stored),
    saveWelcomeTour: vi.fn(async (s: WelcomeTourState) => { saved.push(s); return s; }),
    getUpdateSettings: vi.fn(async () => ({ autoUpdate: false, lastSeenVersion: null })),
    getVersion: vi.fn(async () => '1.0.0'),
  });
  useChromeFlagStore.setState({ enabled: true });
  useProjectStore.setState({ projects: [], activeProjectId: null } as never);
  useUIStore.setState({ explorerTab: 'agents', dispatcherOpen: false, activeHostId: null });
  useOrchestratorStore.setState({ allOrchestrators: [], availability: {} });
  useWelcomeTourStore.setState({ open: false, saved: null, position: { step: 0, scene: 0 } });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('startWelcomeTourIfDue', () => {
  it('opens the new-user tour on a fresh install and records who it was for', async () => {
    await expect(startWelcomeTourIfDue()).resolves.toBe(true);
    const s = useWelcomeTourStore.getState();
    expect(s.open).toBe(true);
    expect(s.variant).toBe('new');
    expect(saved).toEqual([{ seenVersion: 0, variant: 'new', variantVersion: WELCOME_TOUR_VERSION }]);
  });

  it('opens the upgraders\' tour when projects are saved', async () => {
    useProjectStore.setState({ projects: [{ id: 'p1' }] } as never);
    await startWelcomeTourIfDue();
    expect(useWelcomeTourStore.getState()).toMatchObject({ open: true, variant: 'upgrade', hasProjects: true });
  });

  it('opens nothing once this tour version was seen, so What\'s New can show', async () => {
    seed({ seenVersion: WELCOME_TOUR_VERSION });
    await expect(startWelcomeTourIfDue()).resolves.toBe(false);
    expect(useWelcomeTourStore.getState().open).toBe(false);
    expect(saved).toEqual([]);
  });

  it('waits for the new layout: a classic session neither opens it nor marks it', async () => {
    useChromeFlagStore.setState({ enabled: false });
    await expect(startWelcomeTourIfDue()).resolves.toBe(false);
    expect(saved).toEqual([]);
  });

  it('opens the upgraders\' tour for someone with no projects whose earlier run left files', async () => {
    stored = { ...stored, earlierRun: true } as typeof stored;
    await startWelcomeTourIfDue();
    expect(useWelcomeTourStore.getState()).toMatchObject({ open: true, variant: 'upgrade', hasProjects: false });
  });

  it('treats an unreadable state file as upgrading', async () => {
    seed({}, true);
    await startWelcomeTourIfDue();
    expect(useWelcomeTourStore.getState().variant).toBe('upgrade');
  });

  it('never throws when the state can\'t be read at all', async () => {
    (app().getWelcomeTour as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'));
    await expect(startWelcomeTourIfDue()).resolves.toBe(true);
    expect(useWelcomeTourStore.getState().variant).toBe('upgrade');
  });

  it('leaves Settings or Help so the pane shows the tour', async () => {
    useUIStore.setState({ explorerTab: 'help', previousExplorerTab: 'agents' });
    await startWelcomeTourIfDue();
    expect(useUIStore.getState().explorerTab).toBe('agents');
  });
});

describe('the tour', () => {
  async function openAs(variant: 'new' | 'upgrade', hasProjects = variant === 'upgrade') {
    useWelcomeTourStore.setState({ saved: stored.state });
    act(() => useWelcomeTourStore.getState().openTour({ variant, hasProjects, smartRouting: false }));
    render(<WelcomeTour />);
  }

  it('starts on Welcome, with a step bar, and Next moves on', async () => {
    await openAs('new');
    expect(screen.getByTestId('welcome-tour-title').textContent).toBe('Welcome to Clubhouse');
    expect(screen.getAllByRole('button', { name: /^(Welcome|Managed agents|The Dispatcher|Orchestrators|Also new|Get started)$/ })).toHaveLength(6);
    expect(screen.getByTestId('welcome-tour-next').textContent).toBe('Start the tour');
    expect(screen.queryByTestId('welcome-tour-back')).toBeNull();
    fireEvent.click(screen.getByTestId('welcome-tour-next'));
    expect(screen.getByTestId('welcome-tour').getAttribute('data-scene')).toBe('compose');
    expect(screen.getByTestId('welcome-tour-back')).toBeTruthy();
  });

  it('thanks upgraders and opens Managed agents with what happened to their agents', async () => {
    await openAs('upgrade');
    expect(screen.getByTestId('welcome-tour-title').textContent).toBe('Welcome to Clubhouse 1.0');
    expect(screen.getByText(/Thank you for being part of early access/)).toBeTruthy();
    expect(screen.queryByTestId('welcome-tour-step-start')).toBeNull();
    fireEvent.click(screen.getByTestId('welcome-tour-step-managed'));
    expect(screen.getByTestId('welcome-tour').getAttribute('data-scene')).toBe('switched');
  });

  it('ends on Get started for a new user, the empty app\'s own page', async () => {
    await openAs('new', false);
    fireEvent.click(screen.getByTestId('welcome-tour-step-start'));
    expect(screen.getByTestId('welcome-tour-first-run')).toBeTruthy();
    expect(screen.getByTestId('welcome-tour-next').textContent).toBe('Done');
  });

  it('arrow keys move, and Esc closes it as seen', async () => {
    await openAs('new');
    const root = screen.getByTestId('welcome-tour');
    fireEvent.keyDown(root, { key: 'ArrowRight' });
    expect(root.getAttribute('data-step')).toBe('managed');
    fireEvent.keyDown(root, { key: 'ArrowLeft' });
    expect(root.getAttribute('data-step')).toBe('welcome');
    fireEvent.keyDown(root, { key: 'Escape' });
    expect(useWelcomeTourStore.getState().open).toBe(false);
    expect(saved.at(-1)).toEqual({ seenVersion: WELCOME_TOUR_VERSION, variant: 'new', variantVersion: WELCOME_TOUR_VERSION });
  });

  it('moves focus to its heading when it opens', async () => {
    await openAs('new');
    expect(document.activeElement).toBe(screen.getByTestId('welcome-tour-title'));
  });

  it('closes, as seen, when the person opens something else from the sidebar', async () => {
    await openAs('upgrade');
    fireEvent.pointerDown(document.body);
    act(() => useUIStore.setState({ explorerTab: 'settings' }));
    expect(useWelcomeTourStore.getState().open).toBe(false);
    expect(saved.at(-1)?.seenVersion).toBe(WELCOME_TOUR_VERSION);
  });

  it('stays open, unseen, when an agent starts in the background (a plugin or an orchestrator)', async () => {
    vi.useFakeTimers();
    await openAs('upgrade');
    fireEvent.keyDown(document.body, { key: 'a' });
    vi.advanceTimersByTime(USER_NAVIGATION_WINDOW_MS + 1);
    // spawnQuickAgent / spawnDurableAgent make the new agent active.
    act(() => useAgentStore.setState({ activeAgentId: 'spawned-in-background' }));
    act(() => useProjectStore.setState({ activeProjectId: 'p-background' }));
    expect(useWelcomeTourStore.getState().open).toBe(true);
    expect(saved.every((s) => s.seenVersion === 0)).toBe(true);
    // The next change the person makes still closes it.
    fireEvent.pointerDown(document.body);
    act(() => useUIStore.setState({ explorerTab: 'help' }));
    expect(useWelcomeTourStore.getState().open).toBe(false);
  });

  it('ends when a project is added from Get started, however long the folder dialog took', async () => {
    let resolve: (p: unknown) => void = () => {};
    useProjectStore.setState({ pickAndAddProject: vi.fn(() => new Promise((r) => { resolve = r; })) } as never);
    await openAs('new', false);
    fireEvent.click(screen.getByTestId('welcome-tour-step-start'));
    fireEvent.click(screen.getByTestId('first-run-choose'));
    await act(async () => { resolve({ id: 'p1' }); });
    expect(useWelcomeTourStore.getState().open).toBe(false);
  });

  it('changes nothing but its own state, from first step to Done (#2814 must-not-happen list)', async () => {
    // Every bridge call that could write, start, wake, send or pair.
    const writes = /^(save|set|update|create|delete|remove|start|stop|wake|send|apply|pair|enable|disable|connect|dispose|switch|restart|add|kill|spawn|write)/i;
    const spies: Array<[string, ReturnType<typeof vi.fn>]> = [];
    const bridge = window.clubhouse as unknown as Record<string, unknown>;
    for (const [ns, api] of Object.entries(bridge)) {
      if (!api || typeof api !== 'object') continue;
      for (const [name, fn] of Object.entries(api as Record<string, unknown>)) {
        if (typeof fn !== 'function' || !writes.test(name) || name === 'saveWelcomeTour') continue;
        const spy = vi.fn();
        (api as Record<string, unknown>)[name] = spy;
        spies.push([`${ns}.${name}`, spy]);
      }
    }
    await openAs('upgrade');
    for (let i = 0; i < 40 && useWelcomeTourStore.getState().open; i++) fireEvent.click(screen.getByTestId('welcome-tour-next'));
    expect(useWelcomeTourStore.getState().open).toBe(false);
    expect(spies.filter(([, spy]) => spy.mock.calls.length > 0).map(([name]) => name)).toEqual([]);
    expect(saved.at(-1)).toEqual({ seenVersion: WELCOME_TOUR_VERSION, variant: 'upgrade', variantVersion: WELCOME_TOUR_VERSION });
  });

  it('doesn\'t open from anywhere in the classic layout, where there\'s no pane for it', async () => {
    useChromeFlagStore.setState({ enabled: false });
    await openWelcomeTour();
    expect(useWelcomeTourStore.getState().open).toBe(false);
  });

  it('reopens from Help at the first step, with the audience it was decided for', async () => {
    seed({ seenVersion: WELCOME_TOUR_VERSION, variant: 'new', variantVersion: WELCOME_TOUR_VERSION });
    useProjectStore.setState({ projects: [{ id: 'p1' }] } as never);
    useUIStore.setState({ explorerTab: 'help', previousExplorerTab: 'agents' });
    await openWelcomeTour();
    expect(useWelcomeTourStore.getState()).toMatchObject({ open: true, variant: 'new', hasProjects: true, position: { step: 0, scene: 0 } });
    expect(useUIStore.getState().explorerTab).toBe('agents');
  });
});

describe('help links', () => {
  it('every link finds a topic Help has today, except the ones shown only once their page exists', () => {
    for (const [link, ids] of Object.entries(HELP_LINKS)) {
      if (LINKS_WITHOUT_STAND_IN.includes(link as never)) continue;
      // Each list ends on a topic that exists now, so nothing links nowhere.
      expect(findHelpTopic(ids), link).not.toBeNull();
    }
  });

  it('the upgraders\' "Everything that changed" link waits for Coming from classic', () => {
    const Extra = SCENES['welcome-upgrade'].Extra!;
    const { container } = render(<Extra />);
    expect(container.textContent).toBe(findHelpTopic(HELP_LINKS.fromClassic) ? 'Everything that changed, in Help' : '');
  });

  it('opening one closes the tour and shows the topic', () => {
    useWelcomeTourStore.setState({ open: true });
    openHelpLink('dispatcher');
    expect(useWelcomeTourStore.getState().open).toBe(false);
    expect(useUIStore.getState()).toMatchObject({ explorerTab: 'help', helpTopicId: 'agents-dispatcher' });
  });
});

describe('playScene', () => {
  it('with reduced motion, every step lands at once in its final state', () => {
    vi.useFakeTimers();
    const root = document.createElement('div');
    root.innerHTML = '<div class="a"></div><div class="b"><span class="st">Working</span></div>';
    playScene(root, (c) => { c.on(5000, '.a'); c.status(9000, '.b', 'Idle', 'ok'); }, true);
    vi.advanceTimersByTime(0);
    expect(root.querySelector('.a')!.classList.contains('in')).toBe(true);
    expect(root.querySelector('.st')!.textContent).toBe('Idle');
  });

  it('stopping cancels what hasn\'t run yet', () => {
    vi.useFakeTimers();
    const root = document.createElement('div');
    root.innerHTML = '<div class="a"></div>';
    const stop = playScene(root, (c) => c.on(500, '.a'), false);
    stop();
    vi.advanceTimersByTime(1000);
    expect(root.querySelector('.a')!.classList.contains('in')).toBe(false);
  });
});
