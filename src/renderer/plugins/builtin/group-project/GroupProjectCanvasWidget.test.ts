import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const source = readFileSync(join(__dirname, 'GroupProjectCanvasWidget.tsx'), 'utf-8');

// ── Polling icon ────────────────────────────────────────────────────

describe('GroupProjectCanvasWidget — PollingIcon', () => {
  it('uses an activity/heartbeat SVG instead of circular sync arrows', () => {
    // The old icon used circular arrow paths (M21.5 2v6h-6 / M2.5 22v-6h6)
    // which looked like a refresh/sync icon. Verify those are gone.
    expect(source).not.toContain('M21.5 2v6h-6');
    expect(source).not.toContain('M2.5 22v-6h6');
  });

  it('renders a heartbeat polyline when active', () => {
    // Active state should show an activity/heartbeat wave
    expect(source).toContain('polyline points="22 12 18 12 15 21 9 3 6 12 2 12"');
  });

  it('renders a flat line when inactive', () => {
    // Inactive state should show a straight horizontal line
    expect(source).toMatch(/x1="2".*y1="12".*x2="22".*y2="12"/);
  });
});

// ── Polling toggle label ────────────────────────────────────────────

describe('GroupProjectCanvasWidget — polling toggle has label', () => {
  it('renders "Poll: On" and "Poll: Off" labels to indicate state', () => {
    expect(source).toContain("'Poll: On'");
    expect(source).toContain("'Poll: Off'");
    // The label is inside a span sibling to PollingIcon
    expect(source).toMatch(/PollingIcon[\s\S]*?font-medium[\s\S]*?Poll: On/);
  });

  it('uses muted styling when polling is off (default)', () => {
    // Off state should use overlay0 + bg-surface-0 to look clearly disabled
    expect(source).toContain("'text-ctp-overlay0 bg-surface-0'");
  });
});

// ── Activity dot ────────────────────────────────────────────────────

describe('GroupProjectCanvasWidget — activity dot', () => {
  it('does not use animate-pulse which looks like sync', () => {
    // The activity dot should NOT use animate-pulse as it was confusing
    expect(source).not.toContain('animate-pulse');
  });

  it('still uses green color for active status', () => {
    expect(source).toContain('bg-ctp-green');
  });
});

// ── Activity summary in compact card ────────────────────────────────

describe('GroupProjectCanvasWidget — activity summary', () => {
  it('shows topic and message counts in compact card', () => {
    // The compact ProjectCard should display topic count and message count
    expect(source).toMatch(/topics\.length.*topic/);
    expect(source).toMatch(/totalMessages.*msg/);
  });

  it('highlights new messages when present', () => {
    // Should show a +N new indicator in green when there are new messages
    expect(source).toContain('totalNew > 0');
    expect(source).toContain('text-ctp-green');
    expect(source).toMatch(/\+.*new/);
  });

  it('polls bulletin digest on the compact card', () => {
    // Compact card should call getBulletinDigest for activity data
    expect(source).toContain('getBulletinDigest(groupProjectId)');
  });
});

// ── generateDisplayName in plugin main ──────────────────────────────

describe('GroupProjectCanvasWidget — main.ts generateDisplayName', () => {
  const mainSource = readFileSync(join(__dirname, 'main.ts'), 'utf-8');

  it('provides a generateDisplayName callback', () => {
    expect(mainSource).toContain('generateDisplayName');
  });

  it('returns the project name from metadata when available', () => {
    // The callback should check metadata.name
    expect(mainSource).toContain('metadata.name');
  });
});

// ── PTY injection helper ────────────────────────────────────────────

describe('GroupProjectCanvasWidget — PTY injection', () => {
  it('imports ptyWrite from project-proxy', () => {
    expect(source).toContain("from '../../../services/project-proxy'");
    expect(source).toContain('ptyWrite');
  });

  it('defines injectPtyMessage helper that uses bracketed paste', () => {
    expect(source).toContain('function injectPtyMessage');
    expect(source).toContain('\\x1b[200~');
    expect(source).toContain('\\x1b[201~');
  });

  it('sends Enter after injection with a delay', () => {
    // injectPtyMessage should call ptyWrite with \r after a timeout
    expect(source).toMatch(/setTimeout\s*\(\s*\(\)\s*=>\s*ptyWrite\s*\(/);
  });
});

// ── Broadcast uses PTY injection ────────────────────────────────────

describe('GroupProjectCanvasWidget — broadcast modal', () => {
  it('does not use sendShoulderTap for broadcast', () => {
    // The broadcast modal should use injectPtyMessage, not sendShoulderTap
    expect(source).not.toMatch(/sendShoulderTap\s*\(/);
  });

  it('calls injectPtyMessage for each target agent in broadcast', () => {
    // ShoulderTapModal handleSend should iterate targets and call injectPtyMessage
    expect(source).toMatch(/for\s*\(const\s+agent\s+of\s+targets\)/);
    expect(source).toContain('injectPtyMessage(agent.agentId');
  });
});

// ── Message ordering (newest-first feed) ────────────────────────────

describe('GroupProjectCanvasWidget — message ordering', () => {
  it('sorts messages newest-first in expanded view using sortedMessages', () => {
    // The expanded view should sort messages by timestamp descending
    expect(source).toContain('sortedMessages');
    expect(source).toMatch(/\[\.\.\.messages\]\.sort\(/);
    expect(source).toMatch(/b\.timestamp\.localeCompare\(a\.timestamp\)/);
  });

  it('renders sortedMessages instead of raw messages in the list', () => {
    // The message list pane should iterate over sortedMessages, not messages
    expect(source).toContain('sortedMessages.map((m)');
    expect(source).toContain('sortedMessages.length === 0');
  });
});

// ── Polling toggle uses PTY injection ───────────────────────────────

describe('GroupProjectCanvasWidget — polling toggle', () => {
  it('injects polling message to connected agents via PTY', () => {
    // handleTogglePolling should iterate connectedAgents and call injectPtyMessage
    expect(source).toMatch(/for\s*\(const\s+agent\s+of\s+connectedAgents\)/);
  });
});

// ── MCP gating ──────────────────────────────────────────────────────

describe('GroupProjectCanvasWidget — MCP required gate', () => {
  it('imports useMcpSettingsStore for MCP check', () => {
    expect(source).toContain("from '../../../stores/mcpSettingsStore'");
    expect(source).toContain('useMcpSettingsStore');
  });

  it('reads mcpEnabled from the store', () => {
    expect(source).toContain('useMcpSettingsStore((s) => s.enabled)');
  });

  it('renders an MCP-required placeholder when MCP is disabled', () => {
    expect(source).toContain('!mcpEnabled');
    expect(source).toContain('group-project-mcp-disabled');
    expect(source).toContain('MCP Required');
  });

  it('directs user to enable MCP in settings', () => {
    expect(source).toContain('Settings');
    expect(source).toContain('MCP');
  });
});

// ── Orchestrator-aware polling messages ─────────────────────────────

describe('GroupProjectCanvasWidget — orchestrator-aware polling', () => {
  it('imports shared polling message builders', () => {
    expect(source).toContain("from '../../../../shared/polling-messages'");
    expect(source).toContain('pollingStartMsg');
    expect(source).toContain('pollingStopMsg');
  });

  it('does not define local pollingStartMsg or pollingStopMsg functions', () => {
    // These should come from the shared module, not be defined locally
    expect(source).not.toMatch(/^function pollingStartMsg/m);
    expect(source).not.toMatch(/^function pollingStopMsg/m);
  });

  it('imports useAgentStore for orchestrator lookup', () => {
    expect(source).toContain("from '../../../stores/agentStore'");
    expect(source).toContain('useAgentStore');
  });

  it('looks up orchestrator per agent in handleTogglePolling', () => {
    // Should get agents from store and look up orchestrator per connected agent
    expect(source).toContain('useAgentStore.getState().agents');
    expect(source).toContain('agents[agent.agentId]?.orchestrator');
  });

  it('passes orchestrator to pollingStartMsg and pollingStopMsg', () => {
    expect(source).toMatch(/pollingStartMsg\(name,\s*orchestrator\)/);
    expect(source).toMatch(/pollingStopMsg\(name,\s*orchestrator\)/);
  });
});

// ── Inline description & instructions editor ────────────────────────

describe('GroupProjectCanvasWidget — inline description/instructions editor', () => {
  it('does not have a SettingsModal component', () => {
    expect(source).not.toContain('function SettingsModal');
    expect(source).not.toContain('showSettings');
    expect(source).not.toContain('onShowSettings');
  });

  it('does not have a settings gear button', () => {
    expect(source).not.toContain('Settings gear');
    expect(source).not.toContain("title=\"Settings\"");
  });

  it('has inline textarea for description with label', () => {
    expect(source).toContain('>Description</label>');
    expect(source).toMatch(/editDesc/);
    expect(source).toContain('Purpose of this group project...');
  });

  it('has inline textarea for instructions with label', () => {
    expect(source).toContain('>Instructions</label>');
    expect(source).toMatch(/editInstr/);
    expect(source).toContain('Rules agents must follow...');
  });

  it('uses 5-row textareas for both fields', () => {
    // Both textareas should have rows={5} for ~5 lines of content
    expect(source).toMatch(/rows=\{5\}[\s\S]*?rows=\{5\}/);
  });

  it('tracks unsaved changes to enable/disable save button', () => {
    expect(source).toContain('hasUnsavedChanges');
    // Save button disabled when no changes
    expect(source).toContain('disabled={!hasUnsavedChanges || saving}');
  });

  it('lights up the save button with blue styling when there are unsaved changes', () => {
    // Active state: blue bg with shadow
    expect(source).toContain("'bg-ctp-blue text-white shadow-md hover:opacity-90'");
    // Inactive state: muted
    expect(source).toContain("'bg-surface-0 text-ctp-overlay0 cursor-default'");
  });

  it('syncs local state when project data changes externally', () => {
    // Should have an effect that syncs editDesc/editInstr when project changes
    expect(source).toContain('project?.description, project?.instructions');
    expect(source).toContain("setEditDesc(project.description || '')");
    expect(source).toContain("setEditInstr(project.instructions || '')");
  });

  it('includes shoulder tap toggle in the inline editor', () => {
    expect(source).toContain('shoulderTapEnabled');
    expect(source).toContain('Shoulder Tap');
    expect(source).toMatch(/<Toggle\s+checked=\{shoulderTapEnabled\}/);
  });

  it('saves description, instructions, and shoulderTap together', () => {
    expect(source).toContain('description: editDesc');
    expect(source).toContain('instructions: editInstr');
    expect(source).toContain('metadata: { shoulderTapEnabled }');
  });
});
