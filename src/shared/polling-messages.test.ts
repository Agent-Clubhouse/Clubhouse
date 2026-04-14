import { describe, it, expect } from 'vitest';
import { pollingStartMsg, pollingStopMsg, pollingNudgeMsg } from './polling-messages';

describe('pollingStartMsg', () => {
  it('returns Claude Code-specific instruction with /loop', () => {
    const msg = pollingStartMsg('Alpha Squad', 'claude-code');
    expect(msg).toContain('/loop');
    expect(msg).toContain('read_bulletin');
    expect(msg).toContain('"Alpha Squad"');
  });

  it('returns generic instruction for unknown orchestrator', () => {
    const msg = pollingStartMsg('Alpha Squad', undefined);
    expect(msg).toContain('read_bulletin');
    expect(msg).toContain('"Alpha Squad"');
    expect(msg).not.toContain('/loop');
  });

  it('returns generic instruction for non-claude orchestrators', () => {
    const msg = pollingStartMsg('Alpha Squad', 'codex-cli');
    expect(msg).not.toContain('/loop');
    expect(msg).toContain('read_bulletin');
  });

  it('includes project name in all variants', () => {
    for (const orch of ['claude-code', 'codex-cli', 'copilot-cli', undefined] as const) {
      const msg = pollingStartMsg('My Project', orch);
      expect(msg).toContain('"My Project"');
    }
  });

  it('references the standard channel poll set and the since parameter', () => {
    const msg = pollingStartMsg('Alpha Squad', 'claude-code');
    expect(msg).toContain('since=');
    expect(msg).toContain('channels=');
    expect(msg).toContain('"general"');
    expect(msg).toContain('"control"');
  });

  it('substitutes the agent\'s inbox channel when provided', () => {
    const msg = pollingStartMsg('Alpha Squad', 'claude-code', 'inbox-robin');
    expect(msg).toContain('"inbox-robin"');
    expect(msg).not.toContain('<your-name>');
  });

  it('falls back to a placeholder inbox when inbox channel is not provided', () => {
    const msg = pollingStartMsg('Alpha Squad', 'claude-code');
    expect(msg).toContain('inbox-<your-name>');
  });
});

describe('pollingStopMsg', () => {
  it('tells Claude Code to cancel /loop', () => {
    const msg = pollingStopMsg('Alpha Squad', 'claude-code');
    expect(msg).toContain('/loop');
    expect(msg).toContain('Cancel');
    expect(msg).toContain('"Alpha Squad"');
  });

  it('returns generic stop for unknown orchestrator', () => {
    const msg = pollingStopMsg('Alpha Squad', undefined);
    expect(msg.toLowerCase()).toContain('stop');
    expect(msg).toContain('"Alpha Squad"');
    expect(msg).not.toContain('/loop');
  });

  it('returns generic stop for non-claude orchestrators', () => {
    const msg = pollingStopMsg('Alpha Squad', 'codex-cli');
    expect(msg).not.toContain('/loop');
    expect(msg.toLowerCase()).toContain('stop');
  });
});

describe('pollingNudgeMsg', () => {
  it('references the channels hint for non-Claude agents', () => {
    const msg = pollingNudgeMsg('Alpha Squad', 'codex-cli', 'inbox-robin');
    expect(msg).toContain('channels=');
    expect(msg).toContain('"inbox-robin"');
    expect(msg).toContain('"Alpha Squad"');
    expect(msg).not.toContain('/loop');
  });

  it('prefers /loop phrasing for Claude Code', () => {
    const msg = pollingNudgeMsg('Alpha Squad', 'claude-code', 'inbox-robin');
    expect(msg).toContain('/loop 60s read_bulletin');
    expect(msg).toContain('"inbox-robin"');
  });
});
