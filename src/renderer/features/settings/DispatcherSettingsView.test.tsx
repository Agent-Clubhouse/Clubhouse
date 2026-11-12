import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { DispatcherState } from '../../../shared/dispatcher-types';
import type { ConnectableAgent } from '../../../shared/dispatcher-settings-page';
import { emptyUsageSplit, emptyUsageTotals, type DispatcherUsageSplit } from '../../../shared/dispatcher-usage';
import type { OrchestratorInfo } from '../../../shared/types';
import { useOrchestratorStore } from '../../stores/orchestratorStore';
import { useAgentDetailsStore } from '../agents/details/detailsStore';
import { useDispatcherStore } from '../dispatcher/dispatcherStore';
import { DEFAULT_DISPATCHER_PERSONALITY, PERSONALITY_PRESET_TEXT } from '../../../shared/dispatcher-personality';
import { NO_DISPATCHER_SETUP } from '../../../shared/dispatcher-setup';

import { DispatcherSettingsView, dispatcherSwitchHelp } from './DispatcherSettingsView';

const FOLDER = 'dispatcher-folder';
const OFF: DispatcherState = {
  enabled: false, flagOn: true, savedOn: false, offReason: 'switch_off', classic: false, running: false, agentId: null, path: null, config: null,
  chatAgentId: null, chatPath: null, chatRunning: false, behavior: { level: 'standard', provider: null, auto: { ready: true } },
} as unknown as DispatcherState;
const ON: DispatcherState = {
  enabled: true,
  flagOn: true,
  savedOn: true,
  offReason: null,
  classic: false,
  running: false,
  agentId: 'disp',
  path: FOLDER,
  config: { id: 'disp', name: 'Rosie', color: 'indigo', createdAt: 'now', orchestrator: 'codex-cli', idleSleep: 'never', runtimeMode: 'chat', access: 'full_access', freeAgentMode: true },
  chatAgentId: 'disp-chat',
  chatPath: 'dispatcher-chat-folder',
  chatRunning: false,
  behavior: { level: 'standard', provider: 'codex-cli', auto: { ready: true } },
  models: { byHand: false, chat: null, work: null },
  personality: DEFAULT_DISPATCHER_PERSONALITY,
  setup: NO_DISPATCHER_SETUP,
};

const AGENTS: ConnectableAgent[] = [
  { projectId: 'p-web', projectPath: '/p/web', projectName: 'webapp', agentId: 'lead', name: 'webapp-lead', connected: true, purpose: 'Checkout and payments' },
  { projectId: 'p-web', projectPath: '/p/web', projectName: 'webapp', agentId: 'api', name: 'api-lead', connected: false },
];
const NO_USAGE: DispatcherUsageSplit = emptyUsageSplit('2026-11-08');

const cli = (id: string, displayName: string) => ({ id, displayName, shortName: displayName, capabilities: { permissions: true } }) as unknown as OrchestratorInfo;

let state: DispatcherState;
let agents: ConnectableAgent[];
let emit: ((s: DispatcherState) => void) | null;
let configsChanged: ((projectPath: string) => void) | null;

beforeEach(() => {
  state = OFF;
  agents = AGENTS;
  emit = null;
  configsChanged = null;
  useDispatcherStore.setState({ setupOpen: false });
  window.clubhouse.dispatcher.setPersonality = vi.fn(async (personality) => {
    state = { ...state, personality };
    emit?.(state);
    return state;
  });
  useAgentDetailsStore.setState({ focus: null });
  window.clubhouse.dispatcher.get = vi.fn(async () => state);
  window.clubhouse.dispatcher.setEnabled = vi.fn(async (on: boolean) => {
    state = on ? ON : { ...ON, enabled: false, savedOn: false, offReason: 'switch_off' };
    emit?.(state);
    return state;
  });
  window.clubhouse.dispatcher.onChanged = vi.fn((cb) => { emit = cb; return () => { emit = null; }; });
  window.clubhouse.dispatcher.setBehavior = vi.fn(async (level) => {
    state = { ...state, behavior: { ...state.behavior, level } };
    emit?.(state);
    return state;
  });
  window.clubhouse.dispatcher.clearChat = vi.fn(async () => ({ cleared: 'now' as const }));
  window.clubhouse.dispatcher.forgetEverything = vi.fn(async () => ({ removed: 1, heldNews: 0 }));
  window.clubhouse.dispatcher.getUsage = vi.fn(async () => NO_USAGE);
  window.clubhouse.dispatcher.listConnectableAgents = vi.fn(async () => agents);
  window.clubhouse.agent.onConfigsChanged = vi.fn((cb: (projectPath: string) => void) => { configsChanged = cb; return () => { configsChanged = null; }; }) as never;
  window.clubhouse.agent.setOrchestrationPolicy = vi.fn(async () => ({ ok: true })) as never;
  window.clubhouse.agent.updateDurableConfig = vi.fn(async () => undefined);
  window.clubhouse.agent.updateDurable = vi.fn(async () => undefined) as never;
  window.clubhouse.agent.removeIcon = vi.fn(async () => undefined) as never;
  window.clubhouse.actions.delete = vi.fn(async () => undefined) as never;
  useOrchestratorStore.setState({
    enabled: ['claude-code', 'codex-cli'],
    allOrchestrators: [cli('claude-code', 'Claude Code'), cli('copilot-cli', 'Copilot CLI'), cli('codex-cli', 'Codex CLI'), cli('future-cli', 'Future CLI')],
    loadSettings: async () => {},
  });
});

/**
 * Mounts the page and lets its first read land inside act, so the read's render and its effects
 * have all run before a test edits a field (#3180). React commits the read's render, then yields
 * to the event loop before running its effects. findBy resolves on the DOM change and returns after
 * a setTimeout(0), which on a slow machine can come first. A test's edit then lands before the
 * effect that copies the saved personality into its draft, and that effect undoes it.
 */
async function renderOn(s: DispatcherState = ON) {
  state = s;
  let view!: ReturnType<typeof render>;
  await act(async () => { view = render(<DispatcherSettingsView />); });
  expect(screen.getByRole('heading', { name: 'Identity' })).toBeInTheDocument();
  return view;
}

describe('DispatcherSettingsView', () => {
  describe('the switch', () => {
    it('turns the Dispatcher on and then shows the page\'s sections in order', async () => {
      render(<DispatcherSettingsView />);
      const toggle = await screen.findByRole('switch', { name: 'Turn on Dispatcher' });
      expect(toggle.getAttribute('aria-checked')).toBe('false');
      // The page title only: no section heading repeats it.
      expect(screen.getAllByRole('heading', { name: 'Dispatcher' })).toHaveLength(1);
      expect(screen.queryByRole('heading', { name: 'Identity' })).toBeNull();

      await act(async () => { fireEvent.click(toggle); });
      expect(window.clubhouse.dispatcher.setEnabled).toHaveBeenCalledWith(true);
      await waitFor(() => expect(screen.getByRole('switch', { name: 'Turn on Dispatcher' }).getAttribute('aria-checked')).toBe('true'));
      const headings = screen.getAllByRole('heading', { level: 3 }).map((el) => el.textContent);
      expect(headings).toEqual(['Identity', 'Behavior', 'Connected agents', 'Reset']);
    });

    it('has no model, context, access or "runs in" fields', async () => {
      await renderOn();
      for (const label of ['Model', 'Context', 'Access', 'Runs in', 'CLI']) expect(screen.queryByLabelText(label)).toBeNull();
      expect(screen.queryByText(/free agent/i)).toBeNull();
    });

    it('keeps the folder line and Reset while off, and hides the other sections', async () => {
      state = { ...ON, enabled: false };
      render(<DispatcherSettingsView />);
      expect(await screen.findByTestId('dispatcher-folder')).toBeTruthy();
      expect(screen.queryByRole('heading', { name: 'Identity' })).toBeNull();
      expect(screen.getByRole('heading', { name: 'Reset' })).toBeInTheDocument();
    });

    it('shows a loading line until the read lands', async () => {
      let resolve!: (s: DispatcherState) => void;
      window.clubhouse.dispatcher.get = vi.fn(() => new Promise<DispatcherState>((r) => { resolve = r; }));
      render(<DispatcherSettingsView />);
      expect(screen.getByRole('heading', { name: 'Dispatcher' })).toBeTruthy();
      expect(screen.getByTestId('dispatcher-loading').textContent).toBe('Loading');
      await act(async () => { resolve(OFF); });
      expect(screen.queryByTestId('dispatcher-loading')).toBeNull();
      expect(screen.getByRole('switch', { name: 'Turn on Dispatcher' })).toBeTruthy();
    });

    it('says when the read fails, and Retry reads again', async () => {
      window.clubhouse.dispatcher.get = vi.fn()
        .mockRejectedValueOnce(new Error("Error invoking remote method 'dispatcher:get': Error: IPC down"))
        .mockResolvedValue(OFF);
      render(<DispatcherSettingsView />);
      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toBe('Couldn’t load the Dispatcher’s settings. IPC down');
      expect(alert.className).toContain('text-ctp-error');
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
      expect(await screen.findByRole('switch', { name: 'Turn on Dispatcher' })).toBeTruthy();
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('says a running one that is off is still running', async () => {
      state = { ...ON, enabled: false, savedOn: false, offReason: 'switch_off', running: true };
      render(<DispatcherSettingsView />);
      expect((await screen.findByTestId('dispatcher-still-running')).textContent).toBe('It is still running. You can stop it from its view.');
    });

    it('shows a switch error as an alert in the error colour', async () => {
      window.clubhouse.dispatcher.setEnabled = vi.fn().mockRejectedValue(new Error('disk full'));
      render(<DispatcherSettingsView />);
      const toggle = await screen.findByRole('switch', { name: 'Turn on Dispatcher' });
      await act(async () => { fireEvent.click(toggle); });
      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toBe('Couldn’t turn it on. disk full');
      expect(alert.className).toContain('text-ctp-error');
    });

    it('on the classic layout, missing or off can\'t be turned on, and says what to change (#2565)', async () => {
      for (const offState of [
        { ...OFF, classic: true, offReason: 'classic_layout' as const },
        { ...OFF, classic: true, offReason: 'switch_off' as const },
      ]) {
        state = offState;
        const { unmount } = render(<DispatcherSettingsView />);
        const toggle = await screen.findByRole('switch', { name: 'Turn on Dispatcher' });
        expect((toggle as HTMLButtonElement).disabled).toBe(true);
        expect(document.getElementById('dispatcher-enabled-help')?.textContent)
          .toBe('The Dispatcher needs the new layout. Turn off Classic layout in Settings > Display & UI, then restart Clubhouse.');
        fireEvent.click(toggle);
        expect(window.clubhouse.dispatcher.setEnabled).not.toHaveBeenCalled();
        unmount();
      }
    });

    it('on the classic layout, a saved on can be turned off, and the page says it won\'t turn back on (#2565)', async () => {
      state = { ...ON, classic: true };
      render(<DispatcherSettingsView />);
      const on = await screen.findByRole('switch', { name: 'Turn on Dispatcher' });
      expect((on as HTMLButtonElement).disabled).toBe(false);
      const help = document.getElementById('dispatcher-enabled-help')?.textContent;
      expect(help).toContain('It has no row here because its row and view are in the new layout only.');
      expect(help).toContain('can’t be turned back on');
      await act(async () => { fireEvent.click(on); });
      expect(window.clubhouse.dispatcher.setEnabled).toHaveBeenCalledWith(false);
    });
  });

  describe('Identity', () => {
    it('preserves and saves an immediate Name edit on the first read', async () => {
      state = { ...ON, config: { ...ON.config!, name: 'Dispatcher' } };
      let resolveRead!: (value: DispatcherState) => void;
      const firstRead = new Promise<DispatcherState>((resolve) => { resolveRead = resolve; });
      window.clubhouse.dispatcher.get = vi.fn(() => firstRead);
      let observedEdit!: () => void;
      const edited = new Promise<void>((resolve) => { observedEdit = resolve; });
      const events: string[] = [];
      const witness = { focused: false, before: '', afterChange: '', afterEnter: '', events };
      const observer = new MutationObserver(() => {
        const input = document.querySelector('[data-testid="dispatcher-name"]');
        if (!(input instanceof HTMLInputElement)) return;
        observer.disconnect();
        input.addEventListener('change', () => events.push(`change:${input.value}`));
        input.addEventListener('keydown', (event) => events.push(`keydown:${event.key}:${input.value}`));
        input.addEventListener('blur', () => events.push(`blur:${input.value}`));
        input.focus();
        witness.focused = document.activeElement === input;
        witness.before = input.value;
        fireEvent.change(input, { target: { value: 'Rosie' } });
        witness.afterChange = input.value;
        fireEvent.keyDown(input, { key: 'Enter' });
        witness.afterEnter = input.value;
        observedEdit();
      });
      observer.observe(document.body, { childList: true, subtree: true });
      try {
        render(<DispatcherSettingsView />);
        // Keep the first commit reachable before act flushes the initial name effect.
        resolveRead(state);
        await edited;
        await act(async () => {});
        const input = screen.getByLabelText('Name') as HTMLInputElement;
        const saveIdentitySpy = vi.mocked(window.clubhouse.agent.updateDurable);
        console.info('IDENTITY_INITIAL_NAME_PROBE', JSON.stringify({
          ...witness,
          afterEffects: input.value,
          saveCalls: saveIdentitySpy.mock.calls,
        }));
        expect(witness.focused).toBe(true);
        expect(witness.before).toBe('Dispatcher');
        expect(witness.afterChange).toBe('Rosie');
        expect(events).toContain('keydown:Enter:Rosie');
        expect(events).toContain('blur:Rosie');
        expect(saveIdentitySpy).toHaveBeenCalledWith(FOLDER, 'disp', { name: 'Rosie' });
      } finally {
        observer.disconnect();
      }
    });

    it('resyncs changed saved names and keeps the Name draft across unrelated config changes', async () => {
      await renderOn();
      const name = screen.getByLabelText('Name') as HTMLInputElement;
      fireEvent.change(name, { target: { value: 'Draft' } });
      await act(async () => { emit?.({ ...ON, config: { ...ON.config!, color: 'emerald' } }); });
      expect(name.value).toBe('Draft');

      await act(async () => { emit?.({ ...ON, config: { ...ON.config!, name: 'Juniper' } }); });
      expect(name.value).toBe('Juniper');
      fireEvent.change(name, { target: { value: 'Other draft' } });
      await act(async () => { emit?.({ ...ON, config: { ...ON.config!, name: 'Juniper', color: 'pink' } }); });
      expect(name.value).toBe('Other draft');

      await act(async () => { emit?.(ON); });
      expect(name.value).toBe('Rosie');
      expect(window.clubhouse.agent.updateDurable).not.toHaveBeenCalled();
    });

    it('saves a new name on Enter, and Escape puts the saved one back', async () => {
      await renderOn();
      const name = screen.getByLabelText('Name') as HTMLInputElement;
      expect(name.value).toBe('Rosie');
      expect(screen.getByText('Shows in the sidebar, in its chat and on your phone. Its internal agent appears as Dispatcher controller.')).toBeInTheDocument();
      fireEvent.change(name, { target: { value: '  Juniper ' } });
      await act(async () => { fireEvent.keyDown(name, { key: 'Enter' }); fireEvent.blur(name); });
      expect(window.clubhouse.agent.updateDurable).toHaveBeenCalledWith(FOLDER, 'disp', { name: 'Juniper' });

      vi.mocked(window.clubhouse.agent.updateDurable).mockClear();
      fireEvent.change(name, { target: { value: 'Other' } });
      fireEvent.keyDown(name, { key: 'Escape' });
      expect(name.value).toBe('Rosie');
      fireEvent.change(name, { target: { value: '   ' } });
      await act(async () => { fireEvent.blur(name); });
      expect(name.value).toBe('Rosie');
      expect(window.clubhouse.agent.updateDurable).not.toHaveBeenCalled();
    });

    it('saves a color, and removes an emoji icon', async () => {
      await renderOn({ ...ON, config: { ...ON.config!, emoji: '🦊' } });
      const colors = screen.getByRole('radiogroup', { name: 'Color' });
      expect(within(colors).getByRole('radio', { name: 'Indigo' }).getAttribute('aria-checked')).toBe('true');
      await act(async () => { fireEvent.click(within(colors).getByRole('radio', { name: 'Emerald' })); });
      expect(window.clubhouse.agent.updateDurable).toHaveBeenCalledWith(FOLDER, 'disp', { color: 'emerald' });
      await act(async () => { fireEvent.click(screen.getByTestId('dispatcher-icon-remove')); });
      expect(window.clubhouse.agent.updateDurable).toHaveBeenCalledWith(FOLDER, 'disp', { emoji: null });
      expect(window.clubhouse.agent.removeIcon).not.toHaveBeenCalled();
    });

    it('shows a failed save as an alert and keeps the saved name', async () => {
      window.clubhouse.agent.updateDurable = vi.fn().mockRejectedValue(new Error('read-only')) as never;
      await renderOn();
      const name = screen.getByLabelText('Name') as HTMLInputElement;
      fireEvent.change(name, { target: { value: 'Juniper' } });
      await act(async () => { fireEvent.blur(name); });
      expect((await screen.findByTestId('dispatcher-identity-error')).textContent).toBe('Couldn’t save. read-only');
      expect(name.value).toBe('Rosie');
    });

    it('shows the saved personality: its preset and exactly what it\'s told (#3047)', async () => {
      await renderOn({ ...ON, personality: { preset: 'friendly', text: PERSONALITY_PRESET_TEXT.friendly } });
      expect((screen.getByLabelText('Personality') as HTMLSelectElement).value).toBe('friendly');
      expect([...(screen.getByLabelText('Personality') as HTMLSelectElement).options].map((o) => o.textContent)).toEqual(['Friendly', 'Concise', 'Detailed', 'Custom']);
      expect((screen.getByLabelText('What it’s told') as HTMLTextAreaElement).value).toBe(PERSONALITY_PRESET_TEXT.friendly);
      // Nothing to save until something changes.
      expect(screen.queryByTestId('dispatcher-personality-save')).toBeNull();
    });

    it('a preset fills the text, and Save sends both', async () => {
      await renderOn();
      fireEvent.change(screen.getByLabelText('Personality'), { target: { value: 'detailed' } });
      expect((screen.getByLabelText('What it’s told') as HTMLTextAreaElement).value).toBe(PERSONALITY_PRESET_TEXT.detailed);
      await act(async () => { fireEvent.click(screen.getByTestId('dispatcher-personality-save')); });
      expect(window.clubhouse.dispatcher.setPersonality).toHaveBeenCalledWith({ preset: 'detailed', text: PERSONALITY_PRESET_TEXT.detailed });
      await waitFor(() => expect(screen.queryByTestId('dispatcher-personality-save')).toBeNull());
    });

    it('an edit reads as Custom, as in setup, and is saved as written', async () => {
      await renderOn();
      const box = screen.getByLabelText('What it’s told') as HTMLTextAreaElement;
      fireEvent.change(box, { target: { value: 'Warm and upbeat.\nUses first names.' } });
      expect((screen.getByLabelText('Personality') as HTMLSelectElement).value).toBe('custom');
      // Typing a preset's text back reads as that preset again.
      fireEvent.change(box, { target: { value: PERSONALITY_PRESET_TEXT.friendly } });
      expect((screen.getByLabelText('Personality') as HTMLSelectElement).value).toBe('friendly');
      fireEvent.change(box, { target: { value: 'Warm and upbeat.\nUses first names.' } });
      await act(async () => { fireEvent.click(screen.getByTestId('dispatcher-personality-save')); });
      expect(window.clubhouse.dispatcher.setPersonality).toHaveBeenCalledWith({ preset: 'custom', text: 'Warm and upbeat.\nUses first names.' });
    });

    it('Cancel puts the saved text back, and an edit survives an unrelated state change', async () => {
      await renderOn();
      const box = screen.getByLabelText('What it’s told') as HTMLTextAreaElement;
      fireEvent.change(box, { target: { value: 'Draft' } });
      await act(async () => { emit?.({ ...ON, running: true, personality: { ...DEFAULT_DISPATCHER_PERSONALITY } }); });
      expect(box.value).toBe('Draft');
      fireEvent.click(screen.getByTestId('dispatcher-personality-cancel'));
      expect(box.value).toBe(DEFAULT_DISPATCHER_PERSONALITY.text);
      expect(window.clubhouse.dispatcher.setPersonality).not.toHaveBeenCalled();
    });

    it('shows a failed personality save as an alert and keeps the draft', async () => {
      window.clubhouse.dispatcher.setPersonality = vi.fn().mockRejectedValue(new Error('disk full'));
      await renderOn();
      const box = screen.getByLabelText('What it’s told') as HTMLTextAreaElement;
      fireEvent.change(box, { target: { value: 'Draft' } });
      await act(async () => { fireEvent.click(screen.getByTestId('dispatcher-personality-save')); });
      expect((await screen.findByTestId('dispatcher-personality-error')).textContent).toBe('Couldn’t save. disk full');
      expect(box.value).toBe('Draft');
    });

    it('Set up… asks for its setup (its view opens it; the E2E spec covers that)', async () => {
      await renderOn();
      await act(async () => { fireEvent.click(screen.getByTestId('dispatcher-open-setup')); });
      expect(useDispatcherStore.getState().setupOpen).toBe(true);
    });
  });

  describe('Behavior', () => {
    it('saves the level through main, the same setting as the composer chip (#3045)', async () => {
      await renderOn();
      const behavior = screen.getByLabelText('Behavior') as HTMLSelectElement;
      expect(behavior.value).toBe('standard');
      expect([...behavior.options].map((o) => o.textContent)).toEqual(['Light', 'Standard', 'Thorough']);
      await act(async () => { fireEvent.change(behavior, { target: { value: 'thorough' } }); });
      expect(window.clubhouse.dispatcher.setBehavior).toHaveBeenCalledWith('thorough');
      await waitFor(() => expect((screen.getByLabelText('Behavior') as HTMLSelectElement).value).toBe('thorough'));
      expect(screen.getByText(/Checks in frequently/)).toBeInTheDocument();
      expect(window.clubhouse.agent.updateDurableConfig).not.toHaveBeenCalled();
    });

    it('follows a change made from the composer chip', async () => {
      await renderOn();
      await act(async () => { emit?.({ ...ON, behavior: { ...ON.behavior, level: 'light' } }); });
      expect((screen.getByLabelText('Behavior') as HTMLSelectElement).value).toBe('light');
    });

    it('offers Set up Auto only where the mapping can fix it', async () => {
      const { unmount } = await renderOn({ ...ON, behavior: { level: 'thorough', provider: 'codex-cli', auto: { ready: false, code: 'no_valid_mapping' } } });
      expect(screen.getByTestId('dispatcher-behavior-setup-auto')).toBeInTheDocument();
      expect(screen.getByTestId('dispatcher-behavior-auto-note').textContent).toContain('Codex CLI');
      unmount();

      await renderOn({ ...ON, behavior: { level: 'standard', provider: 'future-cli', auto: { ready: false, code: 'auto_not_supported' } } });
      expect(screen.getByTestId('dispatcher-behavior-auto-note').textContent).toContain('Auto doesn’t support Future CLI yet');
      expect(screen.queryByTestId('dispatcher-behavior-setup-auto')).toBeNull();
      expect((screen.getByLabelText('Behavior') as HTMLSelectElement).disabled).toBe(false);
    });

    it('shows a failed level change as an alert and keeps the saved level', async () => {
      window.clubhouse.dispatcher.setBehavior = vi.fn().mockRejectedValue(new Error('disk full'));
      await renderOn();
      await act(async () => { fireEvent.change(screen.getByLabelText('Behavior'), { target: { value: 'light' } }); });
      expect((await screen.findByTestId('dispatcher-behavior-error')).textContent).toBe('Couldn’t change it. disk full');
      expect((screen.getByLabelText('Behavior') as HTMLSelectElement).value).toBe('standard');
    });

    it('Runs on lists enabled providers, warns that a switch starts a fresh conversation and keeps memory, then saves', async () => {
      await renderOn();
      const runsOn = screen.getByLabelText('Runs on') as HTMLSelectElement;
      expect(runsOn.value).toBe('codex-cli');
      expect([...runsOn.options].map((o) => o.value)).toEqual(['claude-code', 'codex-cli']);
      expect(screen.getByText('Switching starts a fresh conversation. Its memory stays, so it picks up from what it remembers.')).toBeInTheDocument();

      // Cancel changes nothing.
      fireEvent.change(runsOn, { target: { value: 'claude-code' } });
      expect(screen.getByText('Run on Claude Code?')).toBeInTheDocument();
      expect(screen.getByText(/Rosie starts a fresh conversation on Claude Code the next time it wakes\. Its memory stays/)).toBeInTheDocument();
      fireEvent.click(screen.getByTestId('confirm-destructive-cancel'));
      expect(window.clubhouse.agent.updateDurableConfig).not.toHaveBeenCalled();

      fireEvent.change(runsOn, { target: { value: 'claude-code' } });
      await act(async () => { fireEvent.click(screen.getByTestId('confirm-destructive-confirm')); });
      expect(window.clubhouse.agent.updateDurableConfig).toHaveBeenCalledWith(FOLDER, 'disp', { orchestrator: 'claude-code', model: 'default' });
    });

    it('saves auto-sleep, and shows a failed save as an alert', async () => {
      await renderOn();
      const autoSleep = screen.getByLabelText('Auto-sleep') as HTMLSelectElement;
      expect(autoSleep.value).toBe('never');
      await act(async () => { fireEvent.change(autoSleep, { target: { value: '30' } }); });
      expect(window.clubhouse.agent.updateDurableConfig).toHaveBeenCalledWith(FOLDER, 'disp', { idleSleep: 30 });

      window.clubhouse.agent.updateDurableConfig = vi.fn().mockRejectedValue(new Error('read-only'));
      await act(async () => { fireEvent.change(autoSleep, { target: { value: 'inherit' } }); });
      expect((await screen.findByTestId('dispatcher-save-error')).textContent).toBe('Couldn’t save. read-only');
    });

    it('shows today\'s usage, conversations apart from background work (#3040)', async () => {
      window.clubhouse.dispatcher.getUsage = vi.fn(async () => ({
        day: '2026-11-08',
        conversations: { ...emptyUsageTotals(), turns: 2, input: 1_200_000, output: 48_000 },
        background: { ...emptyUsageTotals(), turns: 4, input: 300, output: 30 },
      }));
      await renderOn();
      await waitFor(() => expect(screen.getByTestId('dispatcher-usage-conversations-value').textContent).toBe('2 turns, 1.2M tokens in and 48K out'));
      expect(screen.getByTestId('dispatcher-usage-background-value').textContent).toBe('4 turns, 300 tokens in and 30 out');
      expect(screen.getByText('Check-ins and memory upkeep it runs on its own.')).toBeInTheDocument();
    });

    it('says when there is none yet today', async () => {
      await renderOn();
      await waitFor(() => expect(screen.getByTestId('dispatcher-usage-conversations-value').textContent).toBe('None yet'));
      expect(screen.getByTestId('dispatcher-usage-background-value').textContent).toBe('None yet');
    });

    it('says when usage can\'t be read', async () => {
      window.clubhouse.dispatcher.getUsage = vi.fn().mockRejectedValue(new Error('x'));
      await renderOn();
      await waitFor(() => expect(screen.getByTestId('dispatcher-usage-conversations-value').textContent).toBe('Couldn’t read it.'));
    });
  });

  describe('Choose models yourself (#3191)', () => {
    const BY_HAND: DispatcherState = {
      ...ON,
      behavior: { level: 'thorough', provider: 'codex-cli', auto: { ready: false, code: 'no_valid_mapping' } },
      models: {
        byHand: true,
        chat: { provider: 'claude-code', model: 'opus', effort: 'high', contextWindow: null },
        work: { provider: 'codex-cli', model: 'sol', effort: null, contextWindow: '400000' },
      },
    };
    const MODELS: Record<string, string[]> = { 'claude-code': ['default', 'sonnet', 'opus'], 'codex-cli': ['default', 'terra', 'sol'] };

    beforeEach(() => {
      window.clubhouse.agent.getModelOptions = vi.fn(async (_path: string, cli?: string) => (MODELS[cli ?? ''] ?? []).map((id) => ({ id, label: id === 'default' ? 'Default' : id.toUpperCase() }))) as never;
      window.clubhouse.managed.modelEfforts = vi.fn(async (cli: string) => ({
        ok: true as const,
        value: cli === 'claude-code' ? { opus: ['low', 'medium', 'high'], sonnet: ['low', 'high'] } : {},
      })) as never;
      window.clubhouse.agent.getContextWindowOptions = vi.fn(async (_path: string, cli?: string) => (cli === 'codex-cli'
        ? {
          configurable: true, kind: 'context_window', label: 'Context', description: 'How much it reads.', defaultLabel: 'CLI default',
          choices: [{ id: '400000', label: '400K' }, { id: '1000000', label: '1M' }], defaultTokens: null, maxTokens: null, costNote: 'More costs more.', applies: ['launch'],
        }
        : { configurable: false, state: 'unsupported', label: 'Context', reason: 'This CLI has no context setting.' })) as never;
      window.clubhouse.dispatcher.setModels = vi.fn(async (update) => {
        if ('byHand' in update) {
          const picks = update.byHand ? BY_HAND.models : { ...state.models, byHand: false };
          state = { ...state, models: { ...picks, byHand: update.byHand } };
        }
        emit?.(state);
        return state;
      });
    });

    it('off: the switch, Runs on, and no rows; turning it on asks main', async () => {
      await renderOn();
      const toggle = screen.getByRole('switch', { name: 'Choose models yourself' });
      expect(toggle.getAttribute('aria-checked')).toBe('false');
      expect(screen.queryByTestId('dispatcher-models-chat')).toBeNull();
      expect(screen.getByLabelText('Runs on')).toBeInTheDocument();
      expect(screen.getByText(/Covers which models it uses and how often it checks in/)).toBeInTheDocument();
      await act(async () => { fireEvent.click(toggle); });
      expect(window.clubhouse.dispatcher.setModels).toHaveBeenCalledWith({ byHand: true });
      expect(await screen.findByTestId('dispatcher-models-chat')).toBeInTheDocument();
      expect(window.clubhouse.agent.updateDurableConfig).not.toHaveBeenCalled();
    });

    it('on: a row per job with its own provider, model, effort and context, in place of Runs on', async () => {
      await renderOn(BY_HAND);
      expect(screen.queryByLabelText('Runs on')).toBeNull();
      const chat = within(screen.getByTestId('dispatcher-models-chat'));
      const work = within(screen.getByTestId('dispatcher-models-work'));
      expect(chat.getByText('Talking with you')).toBeInTheDocument();
      expect(work.getByText('Working in the background')).toBeInTheDocument();
      await waitFor(() => expect((chat.getByLabelText('Model') as HTMLSelectElement).disabled).toBe(false));
      expect((chat.getByLabelText('Provider') as HTMLSelectElement).value).toBe('claude-code');
      expect([...(chat.getByLabelText('Provider') as HTMLSelectElement).options].map((o) => o.value)).toEqual(['claude-code', 'codex-cli']);
      expect((chat.getByLabelText('Model') as HTMLSelectElement).value).toBe('opus');
      expect([...(chat.getByLabelText('Model') as HTMLSelectElement).options].map((o) => o.value)).toEqual(['default', 'sonnet', 'opus']);
      await waitFor(() => expect([...(chat.getByLabelText('Effort') as HTMLSelectElement).options].map((o) => o.value)).toEqual(['', 'low', 'medium', 'high']));
      expect((chat.getByLabelText('Effort') as HTMLSelectElement).value).toBe('high');
      // Each list is read for the job's own CLI and folder.
      expect(window.clubhouse.agent.getModelOptions).toHaveBeenCalledWith('dispatcher-chat-folder', 'claude-code');
      expect(window.clubhouse.agent.getModelOptions).toHaveBeenCalledWith(FOLDER, 'codex-cli');
      // Context where the CLI offers it, and why not where it doesn't.
      expect(await chat.findByTestId('context-window-unavailable')).toHaveTextContent('This CLI has no context setting.');
      await waitFor(() => expect((work.getByLabelText('Context') as HTMLSelectElement).value).toBe('400000'));
      expect((work.getByLabelText('Model') as HTMLSelectElement).value).toBe('sol');
      // A model with no levels says the CLI decides.
      expect(work.getByText('This model has no effort levels to choose, so the CLI decides.')).toBeInTheDocument();
    });

    it('on: Behavior covers only how often it checks in, without Auto\'s note', async () => {
      await renderOn(BY_HAND);
      expect(screen.getByText(/Covers how often it checks in\. You choose its models below\./)).toBeInTheDocument();
      expect(screen.getByText(/Checks in on your agents frequently\./)).toBeInTheDocument();
      expect(screen.queryByTestId('dispatcher-behavior-auto-note')).toBeNull();
      expect(screen.queryByTestId('dispatcher-behavior-setup-auto')).toBeNull();
    });

    it('sends each change for its job only, through main', async () => {
      await renderOn(BY_HAND);
      const chat = within(screen.getByTestId('dispatcher-models-chat'));
      const work = within(screen.getByTestId('dispatcher-models-work'));
      await waitFor(() => expect((chat.getByLabelText('Model') as HTMLSelectElement).disabled).toBe(false));
      await act(async () => { fireEvent.change(chat.getByLabelText('Model'), { target: { value: 'sonnet' } }); });
      expect(window.clubhouse.dispatcher.setModels).toHaveBeenLastCalledWith({ role: 'chat', model: 'sonnet' });
      await waitFor(() => expect((chat.getByLabelText('Effort') as HTMLSelectElement).disabled).toBe(false));
      await act(async () => { fireEvent.change(chat.getByLabelText('Effort'), { target: { value: '' } }); });
      expect(window.clubhouse.dispatcher.setModels).toHaveBeenLastCalledWith({ role: 'chat', effort: null });
      await act(async () => { fireEvent.change(work.getByLabelText('Provider'), { target: { value: 'claude-code' } }); });
      expect(window.clubhouse.dispatcher.setModels).toHaveBeenLastCalledWith({ role: 'work', provider: 'claude-code' });
      await waitFor(() => expect(work.getByLabelText('Context')).toBeInTheDocument());
      await act(async () => { fireEvent.change(work.getByLabelText('Context'), { target: { value: '' } }); });
      expect(window.clubhouse.dispatcher.setModels).toHaveBeenLastCalledWith({ role: 'work', contextWindow: null });
      expect(window.clubhouse.agent.updateDurableConfig).not.toHaveBeenCalled();
    });

    it('shows a refused pick as an alert on its row', async () => {
      window.clubhouse.dispatcher.setModels = vi.fn().mockRejectedValue(new Error('gpt-9 isn’t a model Codex CLI lists.'));
      await renderOn(BY_HAND);
      const work = within(screen.getByTestId('dispatcher-models-work'));
      await act(async () => { fireEvent.change(work.getByLabelText('Provider'), { target: { value: 'claude-code' } }); });
      expect((await work.findByTestId('dispatcher-models-work-error')).textContent).toBe('Couldn’t save. gpt-9 isn’t a model Codex CLI lists.');
      expect(screen.queryByTestId('dispatcher-models-chat-error')).toBeNull();
    });

    it('turning it off asks main, and Runs on comes back', async () => {
      await renderOn(BY_HAND);
      await act(async () => { fireEvent.click(screen.getByRole('switch', { name: 'Choose models yourself' })); });
      expect(window.clubhouse.dispatcher.setModels).toHaveBeenCalledWith({ byHand: false });
      await waitFor(() => expect(screen.getByLabelText('Runs on')).toBeInTheDocument());
      expect(screen.queryByTestId('dispatcher-models-chat')).toBeNull();
    });
  });

  describe('Connected agents', () => {
    it('lists agents across projects with their switch and description', async () => {
      await renderOn();
      const list = await screen.findByRole('list', { name: 'Connected agents' });
      expect(within(list).getAllByRole('listitem')).toHaveLength(2);
      expect(screen.getByRole('switch', { name: 'Connect webapp-lead in webapp to Rosie' }).getAttribute('aria-checked')).toBe('true');
      expect(screen.getByRole('switch', { name: 'Connect api-lead in webapp to Rosie' }).getAttribute('aria-checked')).toBe('false');
      expect(screen.getByTestId('dispatcher-agent-lead-summary').textContent).toBe('Checkout and payments');
      expect(screen.getByTestId('dispatcher-agent-api-summary').textContent).toBe('Not connected');
      expect(screen.getByText('1 of 2')).toBeInTheDocument();
    });

    it('a switch writes the same setting as the agent\'s card, and a change from the card shows here', async () => {
      await renderOn();
      const api = await screen.findByRole('switch', { name: 'Connect api-lead in webapp to Rosie' });
      agents = [AGENTS[0], { ...AGENTS[1], connected: true }];
      await act(async () => { fireEvent.click(api); });
      expect(window.clubhouse.agent.setOrchestrationPolicy).toHaveBeenCalledWith('/p/web', 'api', { connectToDispatcher: true });
      await waitFor(() => expect(screen.getByRole('switch', { name: 'Connect api-lead in webapp to Rosie' }).getAttribute('aria-checked')).toBe('true'));

      // Turned off from its card: main says the project's configs changed, and the list reads again.
      agents = [{ ...AGENTS[0], connected: false }, { ...AGENTS[1], connected: true }];
      await act(async () => { configsChanged?.('/p/web'); });
      await waitFor(() => expect(screen.getByRole('switch', { name: 'Connect webapp-lead in webapp to Rosie' }).getAttribute('aria-checked')).toBe('false'));
    });

    it('a refused change shows on the row and the switch goes back', async () => {
      window.clubhouse.agent.setOrchestrationPolicy = vi.fn(async () => ({ ok: false, message: 'That project turned orchestration off.' })) as never;
      await renderOn();
      const lead = await screen.findByRole('switch', { name: 'Connect webapp-lead in webapp to Rosie' });
      await act(async () => { fireEvent.click(lead); });
      const row = screen.getByTestId('dispatcher-agent-lead');
      expect(within(row).getByRole('alert').textContent).toBe('That project turned orchestration off.');
      expect(lead.getAttribute('aria-checked')).toBe('true');
    });

    it('Card opens the agent with its Dispatcher card', async () => {
      await renderOn();
      const card = await screen.findByRole('button', { name: 'Open the card for webapp-lead in webapp' });
      await act(async () => { fireEvent.click(card); });
      expect(useAgentDetailsStore.getState().focus).toMatchObject({ agentId: 'lead', card: 'dispatcher' });
      expect(useAgentDetailsStore.getState().open).toBe(true);
    });

    it('says when there are no agents, and when the list can\'t be read', async () => {
      agents = [];
      const { unmount } = await renderOn();
      expect(await screen.findByTestId('dispatcher-agents-empty')).toBeInTheDocument();
      unmount();

      window.clubhouse.dispatcher.listConnectableAgents = vi.fn().mockRejectedValueOnce(new Error('no projects')).mockResolvedValue(AGENTS);
      await renderOn();
      expect((await screen.findByTestId('dispatcher-agents-error')).textContent).toBe('Couldn’t list your agents. no projects');
      await act(async () => { fireEvent.click(within(screen.getByTestId('dispatcher-agents-error').parentElement!).getByRole('button', { name: 'Retry' })); });
      expect(await screen.findByRole('list', { name: 'Connected agents' })).toBeInTheDocument();
    });

    it('opening the page writes nothing', async () => {
      await renderOn();
      await screen.findByRole('list', { name: 'Connected agents' });
      expect(window.clubhouse.agent.setOrchestrationPolicy).not.toHaveBeenCalled();
      expect(window.clubhouse.agent.updateDurableConfig).not.toHaveBeenCalled();
      expect(window.clubhouse.agent.updateDurable).not.toHaveBeenCalled();
    });
  });

  describe('Reset: Forget everything', () => {
    it('asks first, then clears memory only: no agent, connection, Action or chat change', async () => {
      await renderOn();
      await screen.findByRole('list', { name: 'Connected agents' });
      fireEvent.click(screen.getByTestId('dispatcher-forget'));
      expect(screen.getByRole('heading', { name: 'Forget everything?' })).toBeInTheDocument();
      expect(screen.getByText(/This can’t be undone\. Your agents, connections, Actions and its chat stay\./)).toBeInTheDocument();
      expect(window.clubhouse.dispatcher.forgetEverything).not.toHaveBeenCalled();

      await act(async () => { fireEvent.click(screen.getByTestId('confirm-destructive-confirm')); });
      expect(window.clubhouse.dispatcher.forgetEverything).toHaveBeenCalledTimes(1);
      expect((await screen.findByTestId('dispatcher-forget-done')).textContent).toBe('Rosie starts over with an empty memory.');
      expect(window.clubhouse.dispatcher.clearChat).not.toHaveBeenCalled();
      expect(window.clubhouse.agent.setOrchestrationPolicy).not.toHaveBeenCalled();
      expect(window.clubhouse.agent.updateDurableConfig).not.toHaveBeenCalled();
      expect(window.clubhouse.actions.delete).not.toHaveBeenCalled();
      expect(window.clubhouse.dispatcher.setEnabled).not.toHaveBeenCalled();
      // The agents are still listed and connected.
      expect(screen.getByRole('switch', { name: 'Connect webapp-lead in webapp to Rosie' }).getAttribute('aria-checked')).toBe('true');
    });

    it('Cancel forgets nothing', async () => {
      await renderOn();
      fireEvent.click(screen.getByTestId('dispatcher-forget'));
      fireEvent.click(screen.getByTestId('confirm-destructive-cancel'));
      expect(window.clubhouse.dispatcher.forgetEverything).not.toHaveBeenCalled();
      expect(screen.queryByTestId('dispatcher-forget-done')).toBeNull();
    });

    it('shows a failure as an alert', async () => {
      window.clubhouse.dispatcher.forgetEverything = vi.fn().mockRejectedValue(new Error('busy'));
      await renderOn();
      fireEvent.click(screen.getByTestId('dispatcher-forget'));
      await act(async () => { fireEvent.click(screen.getByTestId('confirm-destructive-confirm')); });
      expect((await screen.findByTestId('dispatcher-forget-error')).textContent).toBe('Couldn’t forget everything. busy');
    });
  });

  describe('help text in every combination', () => {
    const help = (s: Partial<DispatcherState>) => dispatcherSwitchHelp({ enabled: false, classic: false, ...s });

    it.each([
      ['new layout, on', { enabled: true }, ['On by default in the new layout.', 'stays asleep', 'memory are kept'], ['Classic layout', 'Clubhouse MCP']],
      ['new layout, off', {}, ['On by default in the new layout, and turned off here.'], ['Classic layout', 'Clubhouse MCP']],
      ['classic, saved on', { enabled: true, classic: true }, ['Classic layout in Settings > Display & UI, then restart Clubhouse.', 'can’t be turned back on'], ['Clubhouse MCP']],
      ['classic, off', { classic: true }, ['The Dispatcher needs the new layout.', 'Classic layout in Settings > Display & UI, then restart Clubhouse.'], ['Clubhouse MCP']],
    ] as const)('%s', (_name, s, has, hasNot) => {
      const text = help(s);
      for (const part of has) expect(text).toContain(part);
      for (const part of hasNot) expect(text).not.toContain(part);
      expect(text).not.toMatch(/—/);
    });
  });
});
