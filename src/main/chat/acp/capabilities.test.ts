import { describe, expect, it } from 'vitest';
import { acpChatCapabilities, negotiate, type AcpSessionFacts } from './capabilities';

const NO_FACTS: AcpSessionFacts = { configOptions: [], commands: false, usage: false };

describe('ACP capabilities', () => {
  it('reads omitted and null session capabilities as not advertised, {} as advertised', () => {
    const n = negotiate({ protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: null, close: {} } } }, true);
    expect([n.resume, n.close, n.loadSession]).toEqual([false, true, false]);
  });

  it('a claim never enables what the handshake left off', () => {
    const noForms = negotiate({ protocolVersion: 1 }, false);
    expect(acpChatCapabilities(noForms, NO_FACTS, { questions: true }).questions).toBe(false);
    const forms = negotiate({ protocolVersion: 1 }, true);
    expect(acpChatCapabilities(forms, NO_FACTS, {}).questions).toBe(false);
    expect(acpChatCapabilities(forms, NO_FACTS, { questions: true }).questions).toBe(true);
  });

  it('keeps mandatory protocol features and the login baseline regardless of advertised bits', () => {
    const caps = acpChatCapabilities(negotiate({ protocolVersion: 1, authMethods: [] }, true), NO_FACTS);
    expect(caps).toMatchObject({ interrupt: true, steer: false, queue: 'client', resume: 'none', images: false, login: 'terminal', liveLevels: [] });
  });
});
