import { describe, it, expect } from 'vitest';
import { pollingStartMsg, pollingStopMsg } from './polling-messages';

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
    expect(msg).toContain('Stop');
    expect(msg).toContain('"Alpha Squad"');
    expect(msg).not.toContain('/loop');
  });

  it('returns generic stop for non-claude orchestrators', () => {
    const msg = pollingStopMsg('Alpha Squad', 'codex-cli');
    expect(msg).not.toContain('/loop');
    expect(msg).toContain('Stop');
  });
});
