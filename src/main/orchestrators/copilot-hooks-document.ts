/** Check documented hook item forms without changing unknown or invalid input. */
function validHookEntry(event: string, value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const kind = item.type ?? 'command';
  const text = (key: string) => typeof item[key] === 'string' && (item[key] as string).trim().length > 0;
  const optionalText = (key: string) => item[key] === undefined || typeof item[key] === 'string';
  const optionalNumber = (key: string) => item[key] === undefined || (typeof item[key] === 'number' && Number.isFinite(item[key]));
  const stringMap = (key: string) => item[key] === undefined || (!!item[key] && typeof item[key] === 'object' && !Array.isArray(item[key]) && Object.values(item[key] as object).every((v) => typeof v === 'string'));
  if (!optionalNumber('timeout') || !optionalNumber('timeoutSec') || !optionalText('matcher')) return false;
  if (kind === 'command') {
    return ['bash', 'powershell', 'command', 'exec'].every(optionalText) &&
      ['bash', 'powershell', 'command', 'exec'].some(text) && optionalText('cwd') &&
      !(item.exec !== undefined && ['bash', 'powershell', 'command'].some((key) => item[key] !== undefined)) &&
      (item.args === undefined || (Array.isArray(item.args) && item.args.every((arg) => typeof arg === 'string'))) &&
      stringMap('env');
  }
  if (kind === 'http') {
    if (!text('url') || !stringMap('headers') ||
        (item.allowedEnvVars !== undefined && (!Array.isArray(item.allowedEnvVars) || !item.allowedEnvVars.every((v) => typeof v === 'string')))) return false;
    try {
      const url = new URL(item.url as string);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
      const requiresHttps = ['preToolUse', 'PreToolUse', 'permissionRequest', 'PermissionRequest'].includes(event) || item.allowedEnvVars !== undefined;
      return !requiresHttps || url.protocol === 'https:';
    } catch {
      return false;
    }
  }
  if (kind === 'prompt') return (event === 'sessionStart' || event === 'SessionStart') && text('prompt');
  // Unknown types may belong to a newer CLI. Refuse to rewrite them, not delete them.
  return false;
}

/** Structural policy shared by launch and cleanup; no I/O or service imports. */
export function isCopilotHooksDocument(value: unknown): value is Record<string, unknown> & { hooks: Record<string, unknown[]> } {
  const doc = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const hooks = doc?.hooks;
  return !!doc && doc.version === 1 && !!hooks && typeof hooks === 'object' && !Array.isArray(hooks) &&
    !Object.entries(hooks).some(([event, entries]) => !Array.isArray(entries) || entries.some((entry) => !validHookEntry(event, entry))) && !('permissions' in doc);
}

function generatedCallbackUrl(url: string, agentRef: string, portRef: string, timeoutSec: unknown): boolean {
  const prefix = 'http://127.0.0.1:';
  if (!url.startsWith(prefix)) return false;
  const hookPath = url.indexOf('/hook/', prefix.length);
  if (hookPath < 0) return false;
  const port = url.slice(prefix.length, hookPath);
  if (port !== portRef && !/^[0-9]+$/.test(port)) return false;
  const endpoint = `/hook/${agentRef}`;
  const suffix = url.slice(hookPath);
  // Both the current writer and the supported fixed-port writer emit these
  // event-specific timeouts, never a timeout-less or millisecond-timeout entry.
  return ['preToolUse', 'postToolUse', 'errorOccurred', 'agentStop', 'permissionRequest', 'sessionStart', 'sessionEnd', 'userPromptSubmitted']
    .some((event) => suffix === `${endpoint}/${event}` && timeoutSec === (event === 'permissionRequest' ? 120 : 5));
}

/** Own the entire generated entry only; user additions make a marked entry ambiguous. */
export function isCopilotClubhouseHookEntry(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  if (entry.type !== 'command' || typeof entry.bash !== 'string') return false;
  if (Object.keys(entry).length !== 3 || !Object.keys(entry).every((key) => ['type', 'bash', 'timeoutSec'].includes(key))) return false;
  const command = entry.bash;
  const posixPrefix = 'cat | curl -s -X POST ';
  const posixSuffix = ' -H \'Content-Type: application/json\' -H "X-Clubhouse-Nonce: ${CLUBHOUSE_HOOK_NONCE}" --data-binary @- || true';
  if (command.startsWith(posixPrefix) && command.endsWith(posixSuffix)) {
    const url = command.slice(posixPrefix.length, -posixSuffix.length);
    return generatedCallbackUrl(url, '${CLUBHOUSE_AGENT_ID}', '${CLUBHOUSE_HOOK_PORT}', entry.timeoutSec);
  }
  const windowsPrefix = 'curl -s -X POST ';
  const windowsSuffix = ' -H "Content-Type: application/json" -H "X-Clubhouse-Nonce: %CLUBHOUSE_HOOK_NONCE%" -d @- || (exit /b 0)';
  if (command.startsWith(windowsPrefix) && command.endsWith(windowsSuffix)) {
    const url = command.slice(windowsPrefix.length, -windowsSuffix.length);
    return generatedCallbackUrl(url, '%CLUBHOUSE_AGENT_ID%', '%CLUBHOUSE_HOOK_PORT%', entry.timeoutSec);
  }
  return false;
}

/** Reserved callback markers without a recognized command require manual review, never deletion. */
export function hasUnrecognizedCopilotCallback(doc: { hooks: Record<string, unknown[]> }): boolean {
  return Object.values(doc.hooks).some((entries) => entries.some((value) => {
    if (isCopilotClubhouseHookEntry(value)) return false;
    const entry = value as Record<string, unknown>;
    return ['bash', 'powershell', 'command', 'exec'].some((key) =>
      typeof entry[key] === 'string' && /CLUBHOUSE_AGENT_ID|CLUBHOUSE_HOOK_NONCE|X-Clubhouse-Nonce/.test(entry[key] as string));
  }));
}
