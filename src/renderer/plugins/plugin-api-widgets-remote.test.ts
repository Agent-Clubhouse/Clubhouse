/**
 * Tests that widget adapters (SleepingAgent, AgentAvatar) resolve agents
 * from both local and remote agent stores — fixing the issue where
 * sleeping remote agents rendered as null.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

describe('widget adapter remote agent support (structural)', () => {
  let source: string;

  beforeAll(() => {
    source = fs.readFileSync(
      path.resolve(__dirname, 'plugin-api-ui.ts'),
      'utf-8',
    );
  });

  it('imports useRemoteProjectStore', () => {
    expect(source).toContain("import { useRemoteProjectStore }");
  });

  it('SleepingAgentAdapter checks remote agent store', () => {
    // Find the SleepingAgentAdapter block
    const adapterStart = source.indexOf('SleepingAgentAdapter');
    const adapterBlock = source.slice(adapterStart, adapterStart + 400);
    expect(adapterBlock).toContain('useRemoteProjectStore');
    expect(adapterBlock).toContain('remoteAgents');
  });

  it('AgentAvatarAdapter checks remote agent store', () => {
    // Find the AgentAvatarAdapter block
    const adapterStart = source.indexOf('AgentAvatarAdapter');
    const adapterBlock = source.slice(adapterStart, adapterStart + 400);
    expect(adapterBlock).toContain('useRemoteProjectStore');
    expect(adapterBlock).toContain('remoteAgents');
  });

  it('SleepingAgentAdapter uses fallback pattern (local || remote)', () => {
    const adapterStart = source.indexOf('SleepingAgentAdapter');
    const adapterBlock = source.slice(adapterStart, adapterStart + 400);
    // Should have both local and remote lookups and combine them
    expect(adapterBlock).toContain('useAgentStore');
    expect(adapterBlock).toContain('useRemoteProjectStore');
    // Should use || fallback pattern
    expect(adapterBlock).toMatch(/localAgent\s*\|\|\s*remoteAgent/);
  });

  it('AgentAvatarAdapter uses fallback pattern (local || remote)', () => {
    const adapterStart = source.indexOf('AgentAvatarAdapter');
    const adapterBlock = source.slice(adapterStart, adapterStart + 400);
    expect(adapterBlock).toContain('useAgentStore');
    expect(adapterBlock).toContain('useRemoteProjectStore');
    expect(adapterBlock).toMatch(/localAgent\s*\|\|\s*remoteAgent/);
  });
});
