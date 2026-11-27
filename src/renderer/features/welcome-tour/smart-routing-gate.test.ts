import { describe, expect, it, vi, beforeEach } from 'vitest';
import { readSmartRoutingScene, smartRoutingSceneShows, type CliReadiness } from './smart-routing-gate';
import { useOrchestratorStore } from '../../stores/orchestratorStore';

const ready = (id: string): CliReadiness => ({ id, installed: true, turnedOn: true });
const allowed = { copilotAllowed: true };

describe('smartRoutingSceneShows (#2814, #3896)', () => {
  it('one CLI: no scene, Smart routing stays a card in Also new', () => {
    expect(smartRoutingSceneShows([ready('claude-code')], allowed)).toBe(false);
  });

  it('Claude Code with Codex: the scene', () => {
    expect(smartRoutingSceneShows([ready('claude-code'), ready('codex-cli')], allowed)).toBe(true);
  });

  it('Claude Code with Copilot: the scene, since one plan can be read', () => {
    expect(smartRoutingSceneShows([ready('claude-code'), ready('copilot-cli')], allowed)).toBe(true);
    expect(smartRoutingSceneShows([ready('codex-cli'), ready('copilot-cli')], allowed)).toBe(true);
  });

  it('Copilot with Antigravity: no scene, nothing to balance on and Antigravity is opt-in', () => {
    expect(smartRoutingSceneShows([ready('copilot-cli'), ready('antigravity-cli')], allowed)).toBe(false);
  });

  it('Antigravity never counts toward the two while it’s opt-in', () => {
    expect(smartRoutingSceneShows([ready('claude-code'), ready('antigravity-cli')], allowed)).toBe(false);
  });

  it('Copilot turned off for Smart routing doesn’t count', () => {
    expect(smartRoutingSceneShows([ready('claude-code'), ready('copilot-cli')], { copilotAllowed: false })).toBe(false);
  });

  it('a CLI that isn’t installed, or is turned off in Agents & CLIs, doesn’t count', () => {
    expect(smartRoutingSceneShows([ready('claude-code'), { id: 'codex-cli', installed: false, turnedOn: true }], allowed)).toBe(false);
    expect(smartRoutingSceneShows([ready('claude-code'), { id: 'codex-cli', installed: true, turnedOn: false }], allowed)).toBe(false);
  });

  it('an unknown CLI id doesn’t count', () => {
    expect(smartRoutingSceneShows([ready('claude-code'), ready('some-new-cli')], allowed)).toBe(false);
  });
});

describe('readSmartRoutingScene', () => {
  beforeEach(() => {
    useOrchestratorStore.setState({
      allOrchestrators: [{ id: 'claude-code', displayName: 'Claude Code' }, { id: 'codex-cli', displayName: 'Codex' }] as never,
      enabled: ['claude-code', 'codex-cli'],
      availability: {},
    });
  });

  it('reads only what the app already keeps: installed, turned on, and the Copilot switch', async () => {
    window.clubhouse.agent.checkOrchestrator = vi.fn(async () => ({ available: true }));
    window.clubhouse.app.getOrchestrationSettings = vi.fn(async () => ({ globalHelperCap: 3, copilotAuto: true })) as never;
    const routing = vi.fn();
    window.clubhouse.app.getHelperRouting = routing as never;
    await expect(readSmartRoutingScene()).resolves.toBe(true);
    // Never the routing read, which asks each CLI for its models and plan.
    expect(routing).not.toHaveBeenCalled();
  });

  it('leaves the scene out when a read fails', async () => {
    window.clubhouse.agent.checkOrchestrator = vi.fn(async () => { throw new Error('nope'); });
    await expect(readSmartRoutingScene()).resolves.toBe(false);
  });
});
