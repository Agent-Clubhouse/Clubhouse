/**
 * The env the Claude chat driver hands its CLI, through both transports:
 * inherited Claude Code host-session vars are gone, user Claude config stays.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('child_process', async (importActual) => ({
  ...await importActual<typeof import('child_process')>(),
  // Stand-in for the login shell: no real shell is sourced.
  execSync: vi.fn(() => 'HOME=/home/user\nPATH=/usr/bin\n'),
}));

import { buildClaudeEnv } from './spawn';
import { ClaudeSdkTransport } from './sdk-transport';
import { ClaudeStreamTransport } from './stream-transport';
import { invalidateShellEnvironmentCache } from '../../util/shell';
import { HOST_SESSION_ENV_FIXTURE, USER_CLAUDE_CONFIG_FIXTURE } from '../../util/__fixtures__/host-session-env';

const polluted = { ...HOST_SESSION_ENV_FIXTURE, ...USER_CLAUDE_CONFIG_FIXTURE };

function expectClean(env: Record<string, string | undefined> | undefined) {
  expect(env).toBeDefined();
  for (const key of Object.keys(HOST_SESSION_ENV_FIXTURE)) expect(env).not.toHaveProperty(key);
  expect(env).toMatchObject(USER_CLAUDE_CONFIG_FIXTURE);
}

beforeEach(() => invalidateShellEnvironmentCache());

describe('Claude chat spawn env', () => {
  it('buildClaudeEnv strips host-session vars from overrides', () => {
    const env = buildClaudeEnv(polluted);
    expectClean(env);
    expect(env.HOME).toBeDefined();
  });

  it('the SDK transport passes the cleaned env as options.env, so the SDK never falls back to process.env', async () => {
    let captured: Record<string, string | undefined> | undefined;
    const transport = new ClaudeSdkTransport(
      { binary: 'claude', cwd: '.', permissionMode: 'default', env: polluted },
      async () => ({
        query: ((args: { options?: { env?: Record<string, string | undefined> } }) => {
          captured = args.options?.env;
          throw new Error('stop after options');
        }) as never,
      }),
    );
    await expect(transport.start()).rejects.toThrow('stop after options');
    expectClean(captured);
  });

  it('the stream-json transport spawns claude with the cleaned env', async () => {
    let captured: Record<string, string | undefined> | undefined;
    const transport = new ClaudeStreamTransport(
      { binary: 'claude', cwd: '.', permissionMode: 'default', env: polluted },
      (opts) => {
        captured = opts.env;
        throw new Error('stop after spawn');
      },
    );
    await expect(transport.start()).rejects.toThrow('stop after spawn');
    expectClean(captured);
  });
});
