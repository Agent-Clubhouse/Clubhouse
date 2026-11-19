import { test, expect } from './reverse-desktops';
import type { ChatEvent } from '../../src/shared/chat';

test.use({ reverseScenario: 'multi-turn' });
test.setTimeout(300_000);

test('one forward carries chat commands, live renderer output and transcript catch-up in both directions', async ({ reverse }) => {
  for (const [caller, receiver] of reverse.directions) {
    const pane = receiver.app.window.locator(`[data-testid="chat-view"][data-agent-pane="${receiver.agentId}"][data-view-context="main"]`);
    const page = await caller.app.window.evaluate(({ machine, id }) => window.clubhouse.annexClient.chatPage(machine, id), {
      machine: receiver.fingerprint, id: receiver.agentId,
    }) as { agentId: string; sessionId: string };
    expect(page.agentId).toBe(receiver.agentId);
    for (const [prompt, answer] of [['Reply with the word one.', 'one'], ['Now reply with the word two.', 'two']] as const) {
      const receipt = await caller.app.window.evaluate(({ machine, agentId, sessionId, prompt }) => window.clubhouse.annexClient.chatCommand(machine, {
        type: 'chat.send', agentId, sessionId, text: prompt,
      }), { machine: receiver.fingerprint, agentId: receiver.agentId, sessionId: page.sessionId, prompt });
      expect(receipt).toMatchObject({ status: 'completed' });
      await expect(pane.locator('[data-testid="chat-agent-message"]').filter({ hasText: answer })).toHaveCount(1, { timeout: 20_000 });
      await expect(pane).toHaveAttribute('data-state', 'idle');
      if (answer === 'one') {
        const connections = reverse.forward.sourcePorts.length;
        reverse.forward.cut();
        await expect.poll(() => reverse.forward.sourcePorts.length, { timeout: 45_000 }).toBeGreaterThan(connections);
        for (const [source, target] of reverse.directions) {
          await expect.poll(async () => {
            const satellites: Array<{ fingerprint: string; state: string }> = await source.app.window.evaluate(() => window.clubhouse.annexClient.getSatellites());
            return satellites.find((satellite) => satellite.fingerprint === target.fingerprint)?.state;
          }, { timeout: 45_000 }).toBe('connected');
        }
      }
    }
    const report = await receiver.fakes.report('claude', receiver.agentId);
    expect(report.mismatch).toBeNull();
    expect(report.unexpected).toEqual([]);
    await expect.poll(async () => {
      const caughtUp = await caller.app.window.evaluate(({ machine, id }) => window.clubhouse.annexClient.chatPage(machine, id), {
        machine: receiver.fingerprint, id: receiver.agentId,
      }) as { events: ChatEvent[] };
      return caughtUp.events.filter((event) => event.type === 'agent_message').length;
    }).toBe(2);
  }
});
