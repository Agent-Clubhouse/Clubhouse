import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Agent } from '../../../shared/types';
import type { BlueprintManifest } from '../../../shared/blueprint-types';
import {
  exportAgentAsTemplate,
  isAgentTemplate,
  extractAgentDef,
} from './agent-template-export';

// ── Helpers ─────────────────────────────────────────────────────────

// Mock crypto.randomUUID for deterministic tests
beforeEach(() => {
  vi.stubGlobal('crypto', { randomUUID: () => 'test-uuid-1234' });
});

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-1',
    projectId: 'proj-1',
    name: 'scout',
    kind: 'durable',
    status: 'idle',
    color: 'blue',
    orchestrator: 'claude-code',
    model: 'opus',
    freeAgentMode: true,
    structuredMode: false,
    worktreePath: '/home/user/.clubhouse/agents/scout',
    ...overrides,
  } as Agent;
}

function makeCanvasManifest(): BlueprintManifest {
  return {
    id: 'bp-1',
    name: 'Multi Canvas',
    version: '1.0.0',
    schemaVersion: 1,
    createdAt: '2026-04-05T00:00:00Z',
    canvas: {
      views: [
        { refId: 'v1', type: 'agent', displayName: 'A', position: { x: 0, y: 0 }, agentRef: 'a1' },
        { refId: 'v2', type: 'agent', displayName: 'B', position: { x: 200, y: 0 }, agentRef: 'a2' },
      ],
      wires: [{ sourceRef: 'v1', targetRef: 'v2' }],
    },
    agents: [
      { refId: 'a1', name: 'scout' },
      { refId: 'a2', name: 'builder' },
    ],
  };
}

// ── exportAgentAsTemplate ───────────────────────────────────────────

describe('exportAgentAsTemplate', () => {
  it('creates a valid BlueprintManifest with single view and agent', () => {
    const agent = makeAgent();
    const result = exportAgentAsTemplate(agent);

    expect(result.id).toBe('test-uuid-1234');
    expect(result.name).toBe('scout Template');
    expect(result.schemaVersion).toBe(1);
    expect(result.version).toBe('1.0.0');
    expect(result.canvas.views).toHaveLength(1);
    expect(result.canvas.wires).toHaveLength(0);
    expect(result.agents).toHaveLength(1);
  });

  it('includes agent config in BlueprintAgentDef', () => {
    const agent = makeAgent();
    const result = exportAgentAsTemplate(agent);

    const agentDef = result.agents![0];
    expect(agentDef.name).toBe('scout');
    expect(agentDef.orchestrator).toBe('claude-code');
    expect(agentDef.model).toBe('opus');
    expect(agentDef.freeAgent).toBe(true);
    expect(agentDef.useWorktree).toBe(true);
    expect(agentDef.structured).toBe(false);
  });

  it('inlines instruction content', () => {
    const agent = makeAgent();
    const result = exportAgentAsTemplate(agent, {
      instructionContent: '# Scout Agent\nYou are a scout.',
    });

    expect(result.agents![0].instructionContent).toBe('# Scout Agent\nYou are a scout.');
  });

  it('includes skills when provided', () => {
    const agent = makeAgent();
    const result = exportAgentAsTemplate(agent, {
      skills: ['commit', 'test', 'lint'],
    });

    expect(result.agents![0].skills).toEqual(['commit', 'test', 'lint']);
  });

  it('includes mcpServers when provided', () => {
    const agent = makeAgent();
    const result = exportAgentAsTemplate(agent, {
      mcpServers: ['filesystem', 'github'],
    });

    expect(result.agents![0].mcpServers).toEqual(['filesystem', 'github']);
  });

  it('omits empty skills and mcpServers arrays', () => {
    const agent = makeAgent();
    const result = exportAgentAsTemplate(agent, {
      skills: [],
      mcpServers: [],
    });

    expect(result.agents![0].skills).toBeUndefined();
    expect(result.agents![0].mcpServers).toBeUndefined();
  });

  it('sets matchBy.name for import-time matching', () => {
    const agent = makeAgent({ name: 'my-builder' });
    const result = exportAgentAsTemplate(agent);

    expect(result.agents![0].matchBy).toEqual({ name: 'my-builder' });
  });

  it('uses custom description when provided', () => {
    const agent = makeAgent();
    const result = exportAgentAsTemplate(agent, {
      description: 'A scouting agent for code exploration',
    });

    expect(result.description).toBe('A scouting agent for code exploration');
  });

  it('generates default description from agent name', () => {
    const agent = makeAgent({ name: 'reviewer' });
    const result = exportAgentAsTemplate(agent);

    expect(result.description).toBe('Agent template exported from reviewer');
  });

  it('includes appVersion in exportedFrom', () => {
    const agent = makeAgent();
    const result = exportAgentAsTemplate(agent, { appVersion: '0.39.0' });

    expect(result.exportedFrom).toBe('0.39.0');
  });

  it('view references the agent def via agentRef', () => {
    const agent = makeAgent();
    const result = exportAgentAsTemplate(agent);

    const view = result.canvas.views[0];
    const agentDef = result.agents![0];
    expect(view.agentRef).toBe(agentDef.refId);
  });

  it('view is positioned at origin with default size', () => {
    const agent = makeAgent();
    const result = exportAgentAsTemplate(agent);

    const view = result.canvas.views[0];
    expect(view.position).toEqual({ x: 0, y: 0 });
    expect(view.size).toBeDefined();
    expect(view.size!.width).toBeGreaterThan(0);
    expect(view.size!.height).toBeGreaterThan(0);
  });

  it('view has isAgentTemplate metadata flag', () => {
    const agent = makeAgent();
    const result = exportAgentAsTemplate(agent);

    expect(result.canvas.views[0].metadata?.isAgentTemplate).toBe(true);
  });

  it('handles agent with minimal config', () => {
    const agent = makeAgent({
      orchestrator: undefined,
      model: undefined,
      freeAgentMode: undefined,
      structuredMode: undefined,
      worktreePath: undefined,
    });
    const result = exportAgentAsTemplate(agent);

    const agentDef = result.agents![0];
    expect(agentDef.orchestrator).toBeUndefined();
    expect(agentDef.model).toBeUndefined();
    expect(agentDef.freeAgent).toBeUndefined();
    expect(agentDef.useWorktree).toBeUndefined();
    expect(agentDef.structured).toBeUndefined();
  });
});

// ── isAgentTemplate ─────────────────────────────────────────────────

describe('isAgentTemplate', () => {
  it('returns true for a single-agent template manifest', () => {
    const agent = makeAgent();
    const manifest = exportAgentAsTemplate(agent);

    expect(isAgentTemplate(manifest)).toBe(true);
  });

  it('returns false for a multi-view canvas blueprint', () => {
    expect(isAgentTemplate(makeCanvasManifest())).toBe(false);
  });

  it('returns false when views are not agent type', () => {
    const manifest: BlueprintManifest = {
      id: 'bp-1',
      name: 'Note',
      version: '1.0.0',
      schemaVersion: 1,
      createdAt: '2026-04-05T00:00:00Z',
      canvas: {
        views: [{ refId: 'v1', type: 'sticky-note', displayName: 'Note', position: { x: 0, y: 0 } }],
        wires: [],
      },
    };

    expect(isAgentTemplate(manifest)).toBe(false);
  });

  it('returns false when wires are present', () => {
    const manifest: BlueprintManifest = {
      id: 'bp-1',
      name: 'Wired',
      version: '1.0.0',
      schemaVersion: 1,
      createdAt: '2026-04-05T00:00:00Z',
      canvas: {
        views: [{ refId: 'v1', type: 'agent', displayName: 'A', position: { x: 0, y: 0 }, agentRef: 'a1' }],
        wires: [{ sourceRef: 'v1', targetRef: 'v1' }],
      },
      agents: [{ refId: 'a1', name: 'scout' }],
    };

    expect(isAgentTemplate(manifest)).toBe(false);
  });

  it('returns false when multiple agents defined', () => {
    const manifest: BlueprintManifest = {
      id: 'bp-1',
      name: 'Multi Agent',
      version: '1.0.0',
      schemaVersion: 1,
      createdAt: '2026-04-05T00:00:00Z',
      canvas: {
        views: [{ refId: 'v1', type: 'agent', displayName: 'A', position: { x: 0, y: 0 } }],
        wires: [],
      },
      agents: [
        { refId: 'a1', name: 'scout' },
        { refId: 'a2', name: 'builder' },
      ],
    };

    expect(isAgentTemplate(manifest)).toBe(false);
  });
});

// ── extractAgentDef ─────────────────────────────────────────────────

describe('extractAgentDef', () => {
  it('extracts agent def from a valid agent template', () => {
    const agent = makeAgent({ name: 'reviewer' });
    const manifest = exportAgentAsTemplate(agent, {
      instructionContent: 'Review code carefully.',
    });

    const def = extractAgentDef(manifest);
    expect(def).toBeDefined();
    expect(def!.name).toBe('reviewer');
    expect(def!.instructionContent).toBe('Review code carefully.');
  });

  it('returns undefined for a non-template manifest', () => {
    expect(extractAgentDef(makeCanvasManifest())).toBeUndefined();
  });
});
