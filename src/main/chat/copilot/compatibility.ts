/** Startup compatibility, independent of the lazy SDK so fallback stays lightweight. */
export function isCopilotProtocolMismatch(message: string): boolean {
  return /SDK protocol version mismatch/i.test(message);
}

export function copilotProtocolRecovery(message: string): string | undefined {
  if (!isCopilotProtocolMismatch(message)) return undefined;
  const pair = 'Copilot chat requires @microsoft/copilot-sdk 2.0.2 (protocol 4) with Copilot CLI 1.0.113 or a newer protocol-4 release.';
  if (/supports versions 3-3.*server reports version 4/i.test(message)) {
    return `${pair} Update Clubhouse to a build with that embedded SDK. Installing an SDK globally does not change Clubhouse's SDK. You can keep using the Terminal view.`;
  }
  if (/server reports version [0-3](?:\D|$)/i.test(message)) {
    return `${pair} Update your installed Copilot CLI. Protocol-3 CLIs require a Clubhouse build with @github/copilot-sdk 1.x. You can keep using the Terminal view; your sessions and configuration are preserved.`;
  }
  return `${pair} Use a CLI and Clubhouse build with matching protocol versions. You can keep using the Terminal view.`;
}
