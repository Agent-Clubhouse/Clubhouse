import { test, expect, connectMcp, toolWithSuffix } from './reverse-desktops';

test.setTimeout(300_000);

test('both directions retain real MCP caller gates, dedup, files and private-shell output without a direct dial', async ({ reverse }) => {
  for (const [caller, receiver] of reverse.directions) {
    const remote = { machine: receiver.fingerprint, projectId: receiver.projectId };
    expect(await caller.app.window.evaluate(({ machine, projectId }) => window.clubhouse.annexClient.fileTree(machine, projectId), remote))
      .toEqual(expect.arrayContaining([expect.objectContaining({ name: 'fixture.txt' })]));
    expect(await caller.app.window.evaluate(({ machine, projectId }) => window.clubhouse.annexClient.fileRead(machine, projectId, 'fixture.txt'), remote))
      .toBe(`bytes from ${receiver === reverse.a ? 'A' : 'B'}\n`);
    const mcp = await connectMcp(caller);
    const status = await toolWithSuffix(mcp, '__get_status');
    expect((await mcp.call(status, {})).isError).toBe(false);
    const send = await toolWithSuffix(mcp, '__send_message');
    const message = `reverse tool delivery from ${caller.agentId}`;
    const args = { message, task_id: `reverse-${caller.agentId}`, idempotency_key: `reverse-${caller.agentId}` };
    const first = await mcp.call(send, args);
    expect(first.isError).toBe(false);
    expect(await mcp.call(send, args)).toEqual(first);
    await expect.poll(async () => receiver.app.window.evaluate(async ({ id, message }) => {
      const events = await window.clubhouse.chat.readTranscript(id);
      return events.filter((event) => event.type === 'user_message' && event.data.source === 'mcp'
        && event.data.content.some((block) => block.type === 'text' && block.text.includes(message))).length;
    }, { id: receiver.agentId, message })).toBe(1);
    const direction = { id: caller.agentId, address: `${receiver.agentId}@${receiver.fingerprint}` };
    await caller.app.window.evaluate(({ id, address }) => window.clubhouse.mcpBinding.setToolsAcrossMachines(id, address, true, ['send_message']), direction);
    expect((await mcp.call(send, { message: 'must not execute', task_id: 'refused' })).isError).toBe(true);
    await caller.app.window.evaluate(({ id, address }) => window.clubhouse.mcpBinding.setToolsAcrossMachines(id, address, true, []), direction);
    expect((await mcp.call(status, {})).isError).toBe(false);

    const shell = { ...remote, shellId: `plugin:terminal:p8-${caller.agentId}` };
    await caller.app.window.evaluate(({ machine, projectId, shellId }) => window.clubhouse.annexClient.ptySpawnShell(machine, shellId, projectId), shell);
    await expect.poll(async () => caller.app.window.evaluate(({ machine, shellId }) => window.clubhouse.annexClient.ptyGetBuffer(machine, shellId), shell), {
      timeout: 20_000, message: 'The real private shell must be ready before input',
    }).not.toBe('');
    await caller.app.window.evaluate(({ machine, shellId }) => window.clubhouse.annexClient.ptyInput(machine, shellId, 'echo $((6*7))\r'), shell);
    await expect.poll(async () => caller.app.window.evaluate(({ machine, shellId }) => window.clubhouse.annexClient.ptyGetBuffer(machine, shellId), shell), {
      timeout: 20_000,
    }).toMatch(/(?:^|\r?\n)42\r?\n/);
    await caller.app.window.evaluate(({ machine, shellId }) => window.clubhouse.annexClient.ptyInput(machine, shellId, 'exit\r'), shell);
  }
});
