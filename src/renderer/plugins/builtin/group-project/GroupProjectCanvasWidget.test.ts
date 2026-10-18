import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const source = readFileSync(join(__dirname, 'GroupProjectCanvasWidget.tsx'), 'utf-8');

// ── Chrome style (#2186) ────────────────────────────────────────────

describe('GroupProjectCanvasWidget — chrome style', () => {
  it('uses no uppercase labels, sub-12px text, native tooltips, accent bars, glows or tinted fills', () => {
    expect(source).not.toMatch(/\buppercase\b|tracking-wide/);
    expect(source).not.toMatch(/text-\[(8|9|10|11)px\]/);
    // Native tooltips; the Modal's title prop is the dialog heading, not a tooltip.
    expect(source).not.toMatch(/\stitle="(?!Broadcast message")/);
    expect(source).not.toMatch(/border-l-2|border-b-2/);
    expect(source).not.toMatch(/shadow-md|animate-pulse/);
    expect(source).not.toMatch(/bg-ctp-[a-z]+\/\d+/);
    expect(source).not.toContain('rounded-full px');
  });

  it('builds controls from the shared Button, Toggle, Modal and Tooltip', () => {
    for (const c of ['Button', 'Toggle', 'Modal', 'Tooltip']) {
      expect(source).toContain(`from '../../../components/${c}'`);
    }
  });

  it('shows member status as the shared dot and word with an 18px avatar', () => {
    expect(source).toContain('<StatusDot dot={dot} />');
    expect(source).toContain('DOT_LABEL[dot]');
    expect(source).toContain('size="2xs"');
  });
});

describe('GroupProjectCanvasWidget — polling switch', () => {
  it('is the shared Toggle, labelled Polling', () => {
    expect(source).toContain('function PollingSwitch');
    expect(source).toMatch(/<Toggle id=\{switchId\} checked=\{on\} onChange=\{onToggle\} \/>/);
    expect(source).toContain('<label htmlFor={switchId}');
    expect(source).toContain('>Polling</label>');
    expect(source).not.toContain('Poll: On');
  });
});

describe('GroupProjectCanvasWidget — activity summary', () => {
  it('shows topic and message counts in compact card', () => {
    expect(source).toMatch(/topics\.length === 1 \? 'topic' : 'topics'/);
    expect(source).toMatch(/totalMessages === 1 \? 'message' : 'messages'/);
  });

  it('adds how many are new when there are new messages', () => {
    expect(source).toContain('totalNew > 0');
    expect(source).toContain('`${totalNew} new`');
  });

  it('polls bulletin digest on the compact card via context hook', () => {
    // Compact card should call fetchDigest for activity data (abstracted via context hook),
    // passing the per-channel read state so its "+N new" count reflects what's unread.
    expect(source).toContain('fetchDigest(groupProjectId, getLastRead(groupProjectId))');
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

// ── PTY injection (via context hook — IPC route) ───────────────────

describe('GroupProjectCanvasWidget — PTY injection via context', () => {
  const hookSource = readFileSync(join(__dirname, 'useGroupProjectContext.ts'), 'utf-8');

  it('does not import ptyWrite — injection routes through main process IPC', () => {
    expect(hookSource).not.toContain('ptyWrite');
    expect(hookSource).not.toContain("from '../../../services/project-proxy'");
  });

  it('delegates bracketed paste to main process (no inline escape codes)', () => {
    expect(hookSource).not.toContain('\\x1b[200~');
    expect(hookSource).not.toContain('\\x1b[201~');
  });

  it('uses groupProject.injectMessage IPC for local injection', () => {
    expect(hookSource).toContain('window.clubhouse.groupProject.injectMessage(agentId, message)');
  });

  it('routes remote injection through annex.gpInjectMessage', () => {
    expect(hookSource).toContain('annex.gpInjectMessage(satelliteId, agentId, message)');
  });
});

// ── Broadcast uses PTY injection ────────────────────────────────────

describe('GroupProjectCanvasWidget — broadcast modal', () => {
  it('does not use sendShoulderTap for broadcast', () => {
    // The broadcast modal should use injectMessage, not sendShoulderTap
    expect(source).not.toMatch(/sendShoulderTap\s*\(/);
  });

  it('calls injectMessage for each target member in broadcast', () => {
    // ShoulderTapModal handleSend should call injectMessage for targets (async via Promise.all)
    expect(source).toContain('injectMessage(member.agentId');
  });
});

// ── Include project instructions checkbox ───────────────────────────

describe('GroupProjectCanvasWidget — include instructions switch', () => {
  it('BroadcastModal accepts projectInstructions prop', () => {
    expect(source).toContain('function BroadcastModal');
    expect(source).toContain('projectInstructions');
  });

  it('uses the shared Toggle for including instructions', () => {
    expect(source).toContain('includeInstructions');
    expect(source).toContain('checked={includeInstructions}');
    expect(source).not.toContain('type="checkbox"');
  });

  it('renders "Include project instructions" label', () => {
    expect(source).toContain('Include project instructions');
  });

  it('disables the switch when projectInstructions is empty', () => {
    expect(source).toContain('const hasInstructions = !!projectInstructions.trim();');
    expect(source).toContain('disabled={!hasInstructions}');
  });

  it('prepends instructions to message when the switch is on', () => {
    expect(source).toContain('Project Instructions:');
    expect(source).toContain('projectInstructions.trim()');
  });

  it('allows sending with only instructions checked and no message', () => {
    expect(source).toContain('!msg && !includeInstructions');
    expect(source).toContain('(!message.trim() && !includeInstructions) || sending');
  });

  it('passes projectInstructions from ProjectCard to BroadcastModal', () => {
    expect(source).toContain("projectInstructions={project?.instructions || ''}");
  });

  it('is the shared Modal', () => {
    expect(source).toMatch(/<Modal\s+open=\{open\}/);
    expect(source).toContain('title="Broadcast message"');
  });
});

// ── Message ordering (newest-first feed) ────────────────────────────

describe('GroupProjectCanvasWidget — message ordering', () => {
  it('sorts messages newest-first in expanded view using sortedMessages', () => {
    // The expanded view should sort messages by numeric message ID descending
    // (LB-AG-002: localeCompare on timestamps gives wrong order for same-second messages)
    expect(source).toContain('sortedMessages');
    expect(source).toMatch(/\[\.\.\.messages\]\.sort\(/);
    // Sort uses numeric ID extraction (id format: prefix_<timestamp>)
    expect(source).toMatch(/parseInt.*split.*\[1\]/);
  });

  it('renders sortedMessages instead of raw messages in the list', () => {
    // The message list pane should iterate over sortedMessages, not messages
    expect(source).toContain('sortedMessages.map((m)');
    expect(source).toContain('sortedMessages.length === 0');
  });
});

// ── Polling toggle delegates to the shared setting code path ────────

describe('GroupProjectCanvasWidget — polling toggle', () => {
  it('delegates persist + member side-effects to ctx.setPolling', () => {
    // handleTogglePolling must call the shared setPolling code path (which the
    // toggle_polling MCP command also uses) rather than persisting + injecting inline.
    expect(source).toContain('await setPolling(groupProjectId, newVal)');
  });

  it('no longer injects polling start/stop messages inline from the toggle', () => {
    expect(source).not.toContain('pollingStartMsg');
    expect(source).not.toContain('pollingStopMsg');
  });

  it('still nudges members directly via injectMessage', () => {
    // The nudge button remains a per-member PTY injection.
    expect(source).toContain('injectMessage(member.agentId, pollingNudgeMsg');
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
    expect(source).toContain('MCP required');
  });

  it('directs user to enable MCP in settings', () => {
    expect(source).toContain('Settings');
    expect(source).toContain('MCP');
  });
});

// ── Orchestrator-aware polling messages ─────────────────────────────

describe('GroupProjectCanvasWidget — orchestrator-aware polling', () => {
  it('imports the shared nudge message builder', () => {
    // The setting toggle now delegates start/stop injection to the main process
    // (setProjectPolling); the widget only builds the per-member nudge itself.
    expect(source).toContain("from '../../../../shared/polling-messages'");
    expect(source).toContain('pollingNudgeMsg');
  });

  it('does not define or inline the start/stop message builders', () => {
    // start/stop are produced server-side in setProjectPolling now.
    expect(source).not.toMatch(/^function pollingStartMsg/m);
    expect(source).not.toMatch(/^function pollingStopMsg/m);
    expect(source).not.toContain('pollingStartMsg');
    expect(source).not.toContain('pollingStopMsg');
  });

  it('imports useAgentStore for nudge orchestrator lookup', () => {
    expect(source).toContain("from '../../../stores/agentStore'");
    expect(source).toContain('useAgentStore');
  });

  it('passes orchestrator to pollingNudgeMsg for the per-member nudge', () => {
    expect(source).toMatch(/pollingNudgeMsg\(name,\s*orchestrator\)/);
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

  it('has inline textarea for description with a sentence-case label', () => {
    expect(source).toContain('>Description</FieldLabel>');
    expect(source).toMatch(/editDesc/);
    expect(source).toContain('What this group project is for');
  });

  it('has inline textarea for instructions with a sentence-case label', () => {
    expect(source).toContain('>Instructions</FieldLabel>');
    expect(source).toMatch(/editInstr/);
    expect(source).toContain('Rules every agent here follows');
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

  it('makes Save the primary button only when there are unsaved changes', () => {
    expect(source).toContain("kind={hasUnsavedChanges ? 'primary' : 'ghost'}");
  });

  it('syncs local state when project data changes externally', () => {
    // Should have an effect that syncs editDesc/editInstr when project changes
    expect(source).toContain('project?.description, project?.instructions');
    expect(source).toContain("setEditDesc(project.description || '')");
    expect(source).toContain("setEditInstr(project.instructions || '')");
  });

  it('uses a simplified default permissions editor instead of legacy toggles', () => {
    expect(source).not.toContain('defaultShoulderTap');
    expect(source).not.toContain('defaultAgentControl');
    expect(source).not.toContain('defaultAgentCleanup');
    expect(source).not.toContain('New connection defaults');
    expect(source).toContain('Default permissions');
    expect(source).toContain('Set defaults');
    expect(source).toContain('WireToolPermissionsDialog');
  });

  it('saves description, instructions, and connection defaults together', () => {
    expect(source).toContain('description: editDesc');
    expect(source).toContain('instructions: editInstr');
    expect(source).toContain('defaultDisabledTools');
    expect(source).toContain('defaultDisabledToolsVersion');
    expect(source).toContain('computeDefaultDisabledTools');
  });

  // Wave 10 #8: scope choice (apply to new vs apply to all) now lives inside
  // the confirm dialog — the inline UI is one Save button, not two.
  it('uses a single Save button that opens an approval dialog for scope', () => {
    expect(source).toContain('group-project-save-defaults-button');
    expect(source).toContain('showApprovalDialog');
    expect(source).toContain("value: 'future'");
    expect(source).toContain("value: 'all'");
    // Old two-button copy gone
    expect(source).not.toContain('Save future');
    expect(source).not.toContain('Apply all');
  });

  // Wave 10 #7: Clear All sits on its own row inside the action column so it
  // isn't clipped at the column's fixed width when the canvas widget is in
  // the maximize/expanded view.
  it('renders Clear all on its own row, confirmed through the shared dialog', () => {
    expect(source).toContain('group-project-clear-all');
    expect(source).toContain("showConfirmDialog('Clear every message?");
  });
});

// ── Optimistic update for remote GP mutations ─────────────────────────

describe('GroupProjectCanvasWidget — remote GP optimistic update', () => {
  const hookSource = readFileSync(join(__dirname, 'useGroupProjectContext.ts'), 'utf-8');

  it('optimistically updates local remote GP store after remote mutation', () => {
    // After calling gpUpdate on the satellite, the hook should update
    // the local remoteGroupProjects store so the UI reflects the change.
    expect(hookSource).toContain('useRemoteProjectStore.getState().updateRemoteGroupProject');
  });

  it('strips namespace prefix when looking up GP in remote store', () => {
    // The gpId might be namespaced (remote||satId||origId) — strip to find in store
    expect(hookSource).toContain("gpId.startsWith('remote||')");
    expect(hookSource).toContain("gpId.split('||').pop()");
  });

  it('merges metadata fields rather than replacing', () => {
    // Metadata updates should merge with existing metadata, not overwrite
    expect(hookSource).toContain('...((existing as any).metadata || {})');
    expect(hookSource).toContain('...fields.metadata');
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

  it('detects remote app-level canvas via activeHostId from useUIStore', () => {
    expect(source).toContain('useUIStore');
    expect(source).toContain('activeHostId');
    expect(source).toContain('isRemoteApp');
  });

  it('computes effective isRemote combining project-level and app-level detection', () => {
    // isRemote should be true when either useRemoteProject detects it OR activeHostId is set in app mode
    expect(source).toContain('const isRemote = remote.isRemote || isRemoteApp');
  });

  it('computes effective satelliteId from either source', () => {
    // satelliteId should come from remote.satelliteId (project-level) or activeHostId (app-level)
    expect(source).toContain('remote.isRemote ? remote.satelliteId : isRemoteApp ? activeHostId : null');
  });

  it('passes computed isRemote and satelliteId to ProjectView', () => {
    expect(source).toContain('isRemote={isRemote}');
    expect(source).toContain('satelliteId={satelliteId}');
  });

  it('uses useGroupProjectContext hook for data abstraction', () => {
    expect(source).toContain('useGroupProjectContext');
    expect(source).toContain('ctx');
  });

  it('MCP check only applies to local mode', () => {
    // MCP gate should be conditioned on !isRemote
    expect(source).toContain('!isRemote && !mcpEnabled');
  });

  it('context hook reads from remote store when isRemote', () => {
    expect(hookSource).toContain('useRemoteProjectStore');
    expect(hookSource).toContain('remoteGroupProjects');
    expect(hookSource).toContain('remoteGroupProjectMembers');
  });

  it('context hook routes mutations through annex API for remote', () => {
    expect(hookSource).toContain('annex.gpUpdate');
    expect(hookSource).toContain('annex.gpBulletinDigest');
    expect(hookSource).toContain('annex.gpBulletinTopic');
    expect(hookSource).toContain('annex.gpBulletinAll');
  });

  it('context hook routes injection through annex.gpInjectMessage for remote', () => {
    expect(hookSource).toContain('annex.gpInjectMessage(satelliteId, agentId, message)');
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
    expect(serverSource).toContain(
      "{ method: 'PATCH', pattern: /^\\/api\\/v1\\/group-projects\\/([^/]+?)$/, handler: handleGroupProjectPatchRoute }",
    );
  });

  it('PATCH route requires mTLS', () => {
    expect(serverSource).toMatch(
      /async function handleGroupProjectPatchRoute[\s\S]*?if \(ctx\.requireMtls\(\)\) return;/,
    );
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

// ── Annex client event forwarding ───────────────────────────────────

describe('GroupProjectCanvasWidget — annex client event forwarding', () => {
  const clientSource = readFileSync(join(__dirname, '../../../../main/services/annex-client.ts'), 'utf-8');

  it('annex-client explicitly handles agent:woken event (not just default case)', () => {
    // agent:woken must be in the explicit case list so it is forwarded to the
    // renderer and the agent status updates from sleeping to running.
    expect(clientSource).toMatch(/case\s+'agent:woken':/);
  });

  it('annex-client explicitly handles agent:spawned event', () => {
    expect(clientSource).toMatch(/case\s+'agent:spawned':/);
  });

  it('annex-client explicitly handles agent:completed event', () => {
    expect(clientSource).toMatch(/case\s+'agent:completed':/);
  });
});

// ── Plugin manifest registry includes group-project ────────────────

describe('GroupProjectCanvasWidget — manifest registry', () => {
  const registrySource = readFileSync(join(__dirname, '../../../../main/services/plugin-manifest-registry.ts'), 'utf-8');

  it('plugin-manifest-registry imports group-project manifest', () => {
    expect(registrySource).toContain("from '../../renderer/plugins/builtin/group-project/manifest'");
  });

  it('group-project is in builtinManifestById map', () => {
    expect(registrySource).toContain('groupProjectManifest.id, groupProjectManifest');
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

// ── Admin (project lead) role in the agent list ─────────────────────

describe('GroupProjectCanvasWidget — admin star + toggle', () => {
  it('marks project leads with the word Lead and a pressed star button', () => {
    expect(source).toContain('function StarIcon');
    expect(source).toContain('<StarIcon filled={lead} />');
    expect(source).toContain('{lead && <span className="text-xs text-ctp-overlay1 flex-shrink-0">Lead</span>}');
  });

  it('toggles admin membership via the project metadata.admins list', () => {
    expect(source).toContain('handleToggleAdmin');
    expect(source).toMatch(/update\(groupProjectId, \{ metadata: \{ admins: next \} \}\)/);
    // Uses the shared add/remove helpers
    expect(source).toContain('addAdmin(project?.metadata');
    expect(source).toContain('removeAdmin(project?.metadata');
  });

  it('computes the admin list from project metadata via the shared helper', () => {
    expect(source).toContain('getProjectAdmins(project?.metadata)');
  });
});

// ── Creation form surfaces errors (regression: silent create failure) ──

describe('GroupProjectCanvasWidget — CreationForm error surfacing', () => {
  it('handleCreate catches errors instead of only using try/finally', () => {
    // Previously handleCreate wrapped create() in try/finally with no catch, so
    // a rejected IPC call (e.g. unregistered group-project:create handler on a
    // fresh Mac) became an unhandled rejection and the card silently reset.
    expect(source).toMatch(/const handleCreate = useCallback\(async \(\) => \{[\s\S]*?\} catch \(err\) \{/);
  });

  it('stores and renders the create error in an alert region', () => {
    expect(source).toContain("setError(`Couldn't create project: ${message}`)");
    expect(source).toContain('role="alert"');
    expect(source).toMatch(/\{error &&/);
  });

  it('clears the error when the user edits the name', () => {
    expect(source).toMatch(/onChange=\{\(e\) => \{ setName\(e\.target\.value\); if \(error\) setError\(null\); \}\}/);
  });
});
