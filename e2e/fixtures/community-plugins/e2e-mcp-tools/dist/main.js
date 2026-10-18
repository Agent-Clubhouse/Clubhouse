// E2E fixture: contributes one MCP tool through the real plugin API, which
// needs the host to have claimed the plugin MCP issuer and minted this
// plugin's token. Records the outcome on the document element for the spec.
const ATTR = 'data-e2e-mcp-tools';

export async function activate(_ctx, api) {
  const root = document.documentElement;
  try {
    await api.mcp.contributeTools([
      {
        name: 'e2e_echo',
        description: 'Echoes its input back (E2E fixture).',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
      },
    ]);
    api.mcp.onToolCall(async (_toolName, args) => ({
      content: [{ type: 'text', text: String(args && args.text) }],
    }));
    const listed = await api.mcp.listContributedTools();
    root.setAttribute(ATTR, `listed:${listed.join(',')}`);
  } catch (err) {
    root.setAttribute(ATTR, `error:${err && err.message ? err.message : String(err)}`);
  }
}
