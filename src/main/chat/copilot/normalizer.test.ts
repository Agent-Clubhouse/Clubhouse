import { describe, expect, it } from 'vitest';
import type { PermissionRequest } from '@github/copilot-sdk';
import { addTokens, copilotErrorCode, copilotPermissionOptions, copilotPermissionView, copilotProviderFromEnv, copilotTokens, copilotToolContent, copilotToolKind, copilotToolTitle } from './normalizer';

const shell = { kind: 'shell', canOfferSessionApproval: true, fullCommandText: 'echo hi', intention: 'say hi', commands: [], hasWriteFileRedirection: false, possiblePaths: [], possibleUrls: [] } as unknown as PermissionRequest;

describe('copilot normalizer', () => {
  it('names tools by what they do, not by Copilot\'s generic title', () => {
    expect(copilotToolKind('bash')).toBe('execute');
    expect(copilotToolKind('some_mcp_tool')).toBe('other');
    expect(copilotToolTitle('bash', { command: 'echo hi', description: 'say hi' }, 'Running command', '/repo')).toBe('say hi');
    expect(copilotToolTitle('bash', { command: 'echo hi' }, 'Running command', '/repo')).toBe('echo hi');
    expect(copilotToolTitle('mystery', undefined, 'Doing it', '/repo')).toBe('Doing it');
    expect(copilotToolTitle('mystery', undefined, undefined, '/repo')).toBe('mystery');
  });

  it('shows a shell result as terminal output and anything else as text', () => {
    expect(copilotToolContent('bash', { command: 'ls' }, 'a\n', 0, '/repo')).toEqual([{ type: 'terminal', command: 'ls', cwd: '/repo', output: 'a\n', exitCode: 0 }]);
    expect(copilotToolContent('view', {}, 'file text', undefined, '/repo')).toEqual([{ type: 'text', text: 'file text' }]);
    expect(copilotToolContent('view', {}, undefined, undefined, '/repo')).toBeUndefined();
  });

  it('offers a session approval only when the request can take one', () => {
    expect(copilotPermissionOptions(shell).map((o) => o.kind)).toEqual(['allow_once', 'allow_always', 'reject_once']);
    const url = { kind: 'url', url: 'https://x', intention: 'look' } as unknown as PermissionRequest;
    expect(copilotPermissionOptions(url).map((o) => o.kind)).toEqual(['allow_once', 'reject_once']);
  });

  it('describes each permission kind, with a diff for a write', () => {
    expect(copilotPermissionView(shell)).toMatchObject({ title: 'say hi', description: 'echo hi', toolName: 'bash' });
    const write = { kind: 'write', fileName: 'a.txt', diff: '+x', intention: 'edit', newFileContents: 'x' } as unknown as PermissionRequest;
    expect(copilotPermissionView(write).content).toEqual([{ type: 'diff', path: 'a.txt', newText: 'x', unifiedDiff: '+x' }]);
    expect(copilotPermissionView({ kind: 'hook' } as unknown as PermissionRequest).title).toBe('Copilot asks to use hook');
  });

  it('classifies errors, including the login message that has no code of its own', () => {
    expect(copilotErrorCode({ message: 'No GitHub OAuth token or Copilot HMAC key provided' })).toBe('auth_required');
    expect(copilotErrorCode({ statusCode: 429 })).toBe('rate_limited');
    expect(copilotErrorCode({ errorType: 'context_limit' })).toBe('context_overflow');
    expect(copilotErrorCode({ message: 'boom' })).toBe('unknown');
  });

  it('maps every documented provider variable, and needs a base URL to turn one on', () => {
    expect(copilotProviderFromEnv({ COPILOT_PROVIDER_API_KEY: 'k', COPILOT_PROVIDER_TYPE: 'openai' })).toBeUndefined();
    expect(copilotProviderFromEnv({ COPILOT_PROVIDER_BASE_URL: '' })).toBeUndefined();
    expect(copilotProviderFromEnv({ COPILOT_PROVIDER_BASE_URL: 'http://x/v1' })).toEqual({ baseUrl: 'http://x/v1' });
    expect(copilotProviderFromEnv({
      COPILOT_PROVIDER_BASE_URL: 'https://x',
      COPILOT_PROVIDER_TYPE: 'azure',
      COPILOT_PROVIDER_WIRE_API: 'responses',
      COPILOT_PROVIDER_TRANSPORT: 'websockets',
      COPILOT_PROVIDER_API_KEY: 'k',
      COPILOT_PROVIDER_API_KEY_COMMAND: 'get-key',
      COPILOT_PROVIDER_BEARER_TOKEN: 'b',
      COPILOT_PROVIDER_AZURE_API_VERSION: '2024-10-21',
      COPILOT_PROVIDER_HEADERS: 'X-One: 1\nX-Two: a:b\\nX-Three: 3',
      COPILOT_PROVIDER_MODEL_ID: 'gpt-5',
      COPILOT_PROVIDER_WIRE_MODEL: 'deployment',
      COPILOT_PROVIDER_MAX_PROMPT_TOKENS: '1000',
      COPILOT_PROVIDER_MAX_OUTPUT_TOKENS: '200',
    })).toEqual({
      baseUrl: 'https://x',
      type: 'azure',
      wireApi: 'responses',
      transport: 'websockets',
      apiKey: 'k',
      apiKeyCommand: 'get-key',
      bearerToken: 'b',
      azure: { apiVersion: '2024-10-21' },
      headers: { 'X-One': '1', 'X-Two': 'a:b', 'X-Three': '3' },
      modelId: 'gpt-5',
      wireModel: 'deployment',
      maxPromptTokens: 1000,
      maxOutputTokens: 200,
    });
  });

  it('drops provider values the CLI wouldn\'t accept', () => {
    expect(copilotProviderFromEnv({
      COPILOT_PROVIDER_BASE_URL: 'http://x',
      COPILOT_PROVIDER_TYPE: 'nonsense',
      COPILOT_PROVIDER_WIRE_API: 'nonsense',
      COPILOT_PROVIDER_TRANSPORT: 'nonsense',
      COPILOT_PROVIDER_HEADERS: 'no colon here',
      COPILOT_PROVIDER_MAX_PROMPT_TOKENS: 'lots',
    })).toEqual({ baseUrl: 'http://x' });
  });

  it('adds up tokens across model calls', () => {
    const a = copilotTokens({ inputTokens: 3, outputTokens: 2, cacheReadTokens: 1 });
    expect(a).toEqual({ input: 3, output: 2, cachedInput: 1, total: 5 });
    expect(addTokens(a, copilotTokens({ inputTokens: 1, outputTokens: 1 }))).toMatchObject({ input: 4, output: 3, cachedInput: 1, total: 7 });
    expect(addTokens(undefined, a)).toBe(a);
  });
});
