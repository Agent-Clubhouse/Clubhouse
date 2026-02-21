import { describe, it, expect } from 'vitest';
import { VoiceRouter } from './voice-router';
import { Agent } from '../../../shared/types';

const agents: Agent[] = [
  { id: 'a1', projectId: 'p1', name: 'Atlas', kind: 'durable', status: 'running', color: 'blue', mission: 'Fix the authentication bug in login.ts' },
  { id: 'a2', projectId: 'p1', name: 'Nova', kind: 'durable', status: 'running', color: 'green', mission: 'Write tests for the payment module' },
];

describe('VoiceRouter', () => {
  const router = new VoiceRouter();

  it('routes by agent name prefix', async () => {
    const result = await router.route('Hey Atlas, check the tests', agents, null);
    expect(result.agentId).toBe('a1');
    expect(result.confidence).toBeGreaterThan(0.8);
  });

  it('strips name prefix from routed text', async () => {
    const result = await router.route('Hey Atlas, check the tests', agents, null);
    expect(result.text).toBe('check the tests');
  });

  it('falls back to focused agent when no name match', async () => {
    const result = await router.route('check the tests', agents, 'a2');
    expect(result.agentId).toBe('a2');
  });

  it('returns first agent when no focus and no name match', async () => {
    const result = await router.route('do something', agents, null);
    expect(result.agentId).toBe('a1');
  });

  // Extra test: throws when no agents available
  it('throws when no agents available', async () => {
    await expect(router.route('hello', [], null)).rejects.toThrow('No agents available for routing');
  });

  // Extra test: context matching (keyword overlap with mission)
  // The filter keeps transcription words with length > 3, then checks which mission words
  // appear in that set. Needs >= 2 overlapping words for context match.
  it('routes by context matching when keywords overlap with mission', async () => {
    // Use agents with missions containing common multi-char words
    const contextAgents: Agent[] = [
      { id: 'c1', projectId: 'p1', name: 'Zeta', kind: 'durable', status: 'running', color: 'red', mission: 'refactor authentication service' },
      { id: 'c2', projectId: 'p1', name: 'Omega', kind: 'durable', status: 'running', color: 'blue', mission: 'update database migrations' },
    ];
    // "authentication" and "service" both > 3 chars and in c1's mission
    const result = await router.route('there is a problem with authentication service', contextAgents, null);
    expect(result.agentId).toBe('c1');
    expect(result.confidence).toBeGreaterThanOrEqual(0.6);
    expect(result.confidence).toBeLessThan(0.95);
  });

  it('routes by context to second agent when keywords match its mission', async () => {
    const contextAgents: Agent[] = [
      { id: 'c1', projectId: 'p1', name: 'Zeta', kind: 'durable', status: 'running', color: 'red', mission: 'refactor authentication service' },
      { id: 'c2', projectId: 'p1', name: 'Omega', kind: 'durable', status: 'running', color: 'blue', mission: 'update database migrations' },
    ];
    // "database" and "migrations" both > 3 chars and in c2's mission
    const result = await router.route('please update database migrations now', contextAgents, null);
    expect(result.agentId).toBe('c2');
    expect(result.confidence).toBeGreaterThanOrEqual(0.6);
  });

  // Extra test: case-insensitive name matching
  it('matches agent name case-insensitively', async () => {
    const result = await router.route('atlas, run the tests', agents, null);
    expect(result.agentId).toBe('a1');
    expect(result.confidence).toBeGreaterThan(0.8);
  });

  it('matches agent name with "ok" prefix case-insensitively', async () => {
    const result = await router.route('OK NOVA, deploy the service', agents, null);
    expect(result.agentId).toBe('a2');
    expect(result.confidence).toBeGreaterThan(0.8);
  });

  it('does not match bare agent name without trailing instruction', async () => {
    const result = await router.route('Hey Atlas', agents, 'a2');
    // "Hey Atlas" has no comma/space+text after name, so name match fails
    // Falls back to focused agent
    expect(result.agentId).toBe('a2');
  });
});
