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

  it('polls bulletin digest on the compact card via context hook', () => {
    // Compact card should call fetchDigest for activity data (abstracted via context hook)
    expect(source).toContain('fetchDigest(groupProjectId)');
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

// ── PTY injection (via context hook) ────────────────────────────────

describe('GroupProjectCanvasWidget — PTY injection via context', () => {
  const hookSource = readFileSync(join(__dirname, 'useGroupProjectContext.ts'), 'utf-8');

  it('imports ptyWrite from project-proxy in the context hook', () => {
    expect(hookSource).toContain("from '../../../services/project-proxy'");
    expect(hookSource).toContain('ptyWrite');
  });

  it('uses bracketed paste for multiline messages', () => {
    expect(hookSource).toContain('\\x1b[200~');
    expect(hookSource).toContain('\\x1b[201~');
  });

  it('sends Enter after injection with a delay', () => {
    expect(hookSource).toMatch(/setTimeout\s*\(/);
    expect(hookSource).toContain("'\\r'");
  });

  it('routes remote PTY input through annexClient', () => {
    expect(hookSource).toContain('annexClient.ptyInput(satelliteId, agentId');
  });
});

// ── Broadcast uses PTY injection ────────────────────────────────────

describe('GroupProjectCanvasWidget — broadcast modal', () => {
  it('does not use sendShoulderTap for broadcast', () => {
    // The broadcast modal should use injectMessage, not sendShoulderTap
    expect(source).not.toMatch(/sendShoulderTap\s*\(/);
  });

  it('calls injectMessage for each target member in broadcast', () => {
    // ShoulderTapModal handleSend should iterate targets and call injectMessage
    expect(source).toMatch(/for\s*\(const\s+member\s+of\s+targets\)/);
    expect(source).toContain('injectMessage(member.agentId');
  });
});

// ── Include project instructions checkbox ───────────────────────────

describe('GroupProjectCanvasWidget — include instructions checkbox', () => {
  it('ShoulderTapModal accepts projectInstructions prop', () => {
    expect(source).toContain('projectInstructions');
  });

  it('has an includeInstructions checkbox state', () => {
    expect(source).toContain('includeInstructions');
    expect(source).toContain("useState(false)");
    expect(source).toContain("type=\"checkbox\"");
  });

  it('renders "Include project instructions" label', () => {
    expect(source).toContain('Include project instructions');
  });

  it('disables checkbox when projectInstructions is empty', () => {
    expect(source).toContain("disabled={!projectInstructions.trim()}");
  });

  it('prepends instructions to message when checkbox is checked', () => {
    expect(source).toContain('Project Instructions:');
    expect(source).toContain('projectInstructions.trim()');
  });

  it('allows sending with only instructions checked and no message', () => {
    expect(source).toContain('!msg && !includeInstructions');
    expect(source).toContain('(!message.trim() && !includeInstructions) || sending');
  });

  it('passes projectInstructions from ProjectCard to ShoulderTapModal', () => {
    expect(source).toContain("projectInstructions={project?.instructions || ''}");
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
  it('injects polling message to members via context hook', () => {
    // handleTogglePolling should iterate members and call injectMessage
    expect(source).toMatch(/for\s*\(const\s+member\s+of\s+members\)/);
    expect(source).toContain('injectMessage(member.agentId');
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

  it('looks up orchestrator per member in handleTogglePolling', () => {
    // Should get agents from store and look up orchestrator per connected member
    expect(source).toContain('useAgentStore.getState().agents');
    expect(source).toContain('agents[member.agentId]?.orchestrator');
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

// ── Annex remote support ─────────────────────────────────────────────

describe('GroupProjectCanvasWidget — Annex remote support', () => {
  const hookSource = readFileSync(join(__dirname, 'useGroupProjectContext.ts'), 'utf-8');
  const manifestSource = readFileSync(join(__dirname, 'manifest.ts'), 'utf-8');

  it('manifest declares annex permission', () => {
    expect(manifestSource).toContain("'annex'");
  });

  it('does not show AnnexUnsupportedPlaceholder for remote', () => {
    expect(source).not.toContain('AnnexUnsupportedPlaceholder');
  });

  it('uses useRemoteProject hook to detect remote context', () => {
    expect(source).toContain('useRemoteProject');
    expect(source).toContain('remote.isRemote');
  });

  it('passes isRemote and satelliteId to ProjectView', () => {
    expect(source).toContain('isRemote={remote.isRemote}');
    expect(source).toContain('satelliteId={remote.satelliteId}');
  });

  it('uses useGroupProjectContext hook for data abstraction', () => {
    expect(source).toContain('useGroupProjectContext');
    expect(source).toContain('ctx');
  });

  it('MCP check only applies to local mode', () => {
    // MCP gate should be conditioned on !remote.isRemote
    expect(source).toContain('!remote.isRemote && !mcpEnabled');
  });

  it('context hook reads from remote store when isRemote', () => {
    expect(hookSource).toContain('useRemoteProjectStore');
    expect(hookSource).toContain('remoteGroupProjects');
    expect(hookSource).toContain('remoteGroupProjectMembers');
  });

  it('context hook routes mutations through annexClient for remote', () => {
    expect(hookSource).toContain('annexClient.gpUpdate');
    expect(hookSource).toContain('annexClient.gpBulletinDigest');
    expect(hookSource).toContain('annexClient.gpBulletinTopic');
    expect(hookSource).toContain('annexClient.gpBulletinAll');
  });

  it('context hook routes PTY input through annexClient for remote', () => {
    expect(hookSource).toContain('annexClient.ptyInput(satelliteId, agentId');
  });

  it('context hook falls back to local API for non-remote', () => {
    expect(hookSource).toContain('window.clubhouse.groupProject.getBulletinDigest');
    expect(hookSource).toContain('window.clubhouse.groupProject.getTopicMessages');
    expect(hookSource).toContain('window.clubhouse.groupProject.getAllMessages');
  });
});

// ── Annex API route (PATCH) ─────────────────────────────────────────

describe('GroupProjectCanvasWidget — annex PATCH route', () => {
  const serverSource = readFileSync(join(__dirname, '../../../../main/services/annex-server.ts'), 'utf-8');

  it('annex server has PATCH route for group project updates', () => {
    expect(serverSource).toContain("method === 'PATCH' && gpPatchMatch");
  });

  it('PATCH route requires mTLS', () => {
    // The PATCH handler should call requireMtls()
    expect(serverSource).toMatch(/PATCH.*gpPatchMatch[\s\S]*?requireMtls\(\)/);
  });

  it('PATCH route supports name, description, instructions, and metadata fields', () => {
    expect(serverSource).toMatch(/body\.name/);
    expect(serverSource).toMatch(/body\.description/);
    expect(serverSource).toMatch(/body\.instructions/);
    expect(serverSource).toMatch(/body\.metadata/);
  });

  it('PATCH route emits group project changed event', () => {
    expect(serverSource).toContain("emitGroupProjectChanged('updated'");
  });
});

// ── Annex client proxy methods ──────────────────────────────────────

describe('GroupProjectCanvasWidget — annex client proxy', () => {
  const clientSource = readFileSync(join(__dirname, '../../../../main/services/annex-client.ts'), 'utf-8');
  const ipcSource = readFileSync(join(__dirname, '../../../../shared/ipc-channels.ts'), 'utf-8');
  const handlersSource = readFileSync(join(__dirname, '../../../../main/ipc/annex-client-handlers.ts'), 'utf-8');

  it('annex-client exports requestGroupProjectGet', () => {
    expect(clientSource).toContain('export function requestGroupProjectGet');
  });

  it('annex-client exports requestGroupProjectUpdate', () => {
    expect(clientSource).toContain('export function requestGroupProjectUpdate');
  });

  it('annex-client exports requestBulletinAllMessages', () => {
    expect(clientSource).toContain('export function requestBulletinAllMessages');
  });

  it('annex-client exports requestBulletinPostMessage', () => {
    expect(clientSource).toContain('export function requestBulletinPostMessage');
  });

  it('annex-client exports requestShoulderTap', () => {
    expect(clientSource).toContain('export function requestShoulderTap');
  });

  it('ipc-channels defines GP_ channels', () => {
    expect(ipcSource).toContain('GP_GET');
    expect(ipcSource).toContain('GP_UPDATE');
    expect(ipcSource).toContain('GP_BULLETIN_DIGEST');
    expect(ipcSource).toContain('GP_BULLETIN_TOPIC');
    expect(ipcSource).toContain('GP_BULLETIN_ALL');
    expect(ipcSource).toContain('GP_BULLETIN_POST');
    expect(ipcSource).toContain('GP_SHOULDER_TAP');
  });

  it('annex-client-handlers registers GP IPC handlers', () => {
    expect(handlersSource).toContain('IPC.ANNEX_CLIENT.GP_GET');
    expect(handlersSource).toContain('IPC.ANNEX_CLIENT.GP_UPDATE');
    expect(handlersSource).toContain('IPC.ANNEX_CLIENT.GP_BULLETIN_DIGEST');
    expect(handlersSource).toContain('IPC.ANNEX_CLIENT.GP_BULLETIN_ALL');
    expect(handlersSource).toContain('IPC.ANNEX_CLIENT.GP_BULLETIN_POST');
    expect(handlersSource).toContain('IPC.ANNEX_CLIENT.GP_SHOULDER_TAP');
  });

  it('satelliteHttpsRequest supports PATCH method', () => {
    expect(clientSource).toMatch(/'GET'\s*\|\s*'POST'\s*\|\s*'PATCH'/);
  });
});

// ── Snapshot richness ───────────────────────────────────────────────

describe('GroupProjectCanvasWidget — snapshot data richness', () => {
  const serverSource = readFileSync(join(__dirname, '../../../../main/services/annex-server.ts'), 'utf-8');
  const typesSource = readFileSync(join(__dirname, '../../../../shared/types.ts'), 'utf-8');

  it('snapshot includes groupProjects list', () => {
    expect(serverSource).toMatch(/groupProjects.*=.*groupProjectRegistry\.list/);
  });

  it('snapshot includes bulletinDigests per project', () => {
    expect(serverSource).toMatch(/bulletinDigests\[gp\.id\]\s*=\s*await\s+board\.getDigest/);
  });

  it('snapshot includes groupProjectMembers per project', () => {
    expect(serverSource).toContain('groupProjectMembers[gp.id] = members');
  });

  it('SatelliteSnapshot type defines groupProjects field', () => {
    expect(typesSource).toContain('groupProjects?: unknown[]');
  });

  it('SatelliteSnapshot type defines bulletinDigests field', () => {
    expect(typesSource).toContain('bulletinDigests?: Record<string, unknown[]>');
  });

  it('SatelliteSnapshot type defines groupProjectMembers field', () => {
    expect(typesSource).toContain('groupProjectMembers?: Record<string, Array<');
  });

  it('annex server broadcasts real-time group project events', () => {
    expect(serverSource).toContain("type: 'group-project:changed'");
    expect(serverSource).toContain("type: 'bulletin:message'");
    expect(serverSource).toContain("type: 'group-project:list'");
  });
});
