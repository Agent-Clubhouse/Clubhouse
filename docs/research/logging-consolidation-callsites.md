# Appendix: legacy log call sites

Generated from PR #2289 head (`e266abc9`) with a TypeScript AST scan of `src/` (tests excluded): every direct `appLog(...)` and `rendererLog(...)` call, 757 in total. Line numbers are from that commit. Expressions that are not string literals are shown in backticks. Chat driver internals log through injected loggers (`this.log`, `onLog`), which are listed in the main report rather than here.

Columns: location, level, message, `meta` keys, and whether the call already passes the opt-in `telemetry` option (log-bridge).

## agents (1)

| Location | Level | Message | meta | tel |
|---|---|---|---|---|
| `main/ipc/agent-handlers.ts:166` | warn | Failed to inject persona instructions on create | agentName, persona, error |  |

## canvas (14)

| Location | Level | Message | meta | tel |
|---|---|---|---|---|
| `renderer/plugins/builtin/canvas/canvas-store.ts:371` | error | ``Skipped malformed canvas instance on ${options.source}`` | id, error |  |
| `renderer/plugins/builtin/canvas/canvas-store.ts:464` | error | Zone wires unreadable — zone wire saves disabled for this session | error |  |
| `renderer/plugins/builtin/canvas/canvas-store.ts:479` | warn | Primary canvas data missing/corrupt — recovered from backup | primary, backupCanvases |  |
| `renderer/plugins/builtin/canvas/canvas-store.ts:490` | error | Canvas data unreadable — not loading, saves blocked | primary, backup, error |  |
| `renderer/plugins/builtin/canvas/canvas-store.ts:522` | warn | Canvas data had malformed records — loaded what was valid | issues |  |
| `renderer/plugins/builtin/canvas/canvas-store.ts:533` | warn | Active canvas id unreadable — defaulting to first canvas | error |  |
| `renderer/plugins/builtin/canvas/canvas-store.ts:553` | error | loadCanvas failed — not loading, saves blocked | error |  |
| `renderer/plugins/builtin/canvas/canvas-store.ts:565` | warn | saveCanvas skipped — canvas was not hydrated from storage |  |  |
| `renderer/plugins/builtin/canvas/canvas-store.ts:577` | warn | saveCanvas deferred — could not confirm storage is empty | error |  |
| `renderer/plugins/builtin/canvas/canvas-store.ts:585` | error | Canvas data appeared after an empty load — reloading instead of overwriting it |  |  |
| `renderer/plugins/builtin/canvas/canvas-store.ts:651` | error | Canvas wires unreadable — wire saves disabled for this session | error |  |
| `renderer/plugins/builtin/canvas/canvas-store.ts:700` | error | Canvas wire restore failed — wire saves disabled for this session | error |  |
| `renderer/plugins/builtin/canvas/canvas-store.ts:711` | warn | saveWires skipped — persisted wires could not be read |  |  |
| `renderer/plugins/builtin/canvas/main.ts:350` | warn | `reason === 'missing_target' ? 'Wire target does not exist on this machine; not binding it' : 'Wire binding ke | agentId, targetId, targetKind |  |

## canvas:main (1)

| Location | Level | Message | meta | tel |
|---|---|---|---|---|
| `renderer/plugins/builtin/canvas/main.ts:433` | error | Cannot open blueprint gallery in project mode without a resolved projectId and projectPath | projectId, projectPath |  |

## core:agent (29)

| Location | Level | Message | meta | tel |
|---|---|---|---|---|
| `main/services/agent-registry.ts:179` | error | ``Unknown orchestrator requested: ${id}`` | orchestratorId, projectPath |  |
| `main/services/agent-runtime/sleep-reason.ts:45` | info | Agent went to sleep | agentId, ......info |  |
| `main/services/agent-runtime/sleep-reason.ts:51` | warn | Failed to save sleep reason | agentId, error |  |
| `main/services/agent-runtime/stale-session.ts:71` | warn | Cleared resume id after a failed resume | agentId, sessionId, reason |  |
| `main/services/agent-system.ts:268` | error | ``Pre-flight check failed for ${provider.id}`` | agentId, error |  |
| `main/services/agent-system.ts:289` | warn | TOML config cleanup failed, continuing spawn | agentId, error |  |
| `main/services/agent-system.ts:307` | warn | Clubhouse mode materialization failed, continuing spawn | agentId, error |  |
| `main/services/agent-system.ts:362` | warn | Could not read the agent's config; starting it at standard access | agentId, error |  |
| `main/services/agent-system.ts:395` | warn | Saved session is gone from the CLI store; starting fresh | agentId, sessionId |  |
| `main/services/agent-system.ts:419` | warn | Failed to clear the last sleep reason | agentId, error |  |
| `main/services/agent-system.ts:489` | warn | ``Skipping wrapper: ${v.reason}`` | agentId |  |
| `main/services/agent-system.ts:665` | warn | ``Skipping wrapper: ${v.reason}`` | agentId |  |
| `main/services/agent-system.ts:675` | info | ``Spawning ${params.kind} agent`` | agentId, orchestrator, binary, args, cwd, model, hookConfigPath, allowedTools, commandPrefix |  |
| `main/services/agent-system.ts:702` | info | Profile env injected | agentId, profileKeys |  |
| `main/services/agent-system.ts:765` | warn | Resume failed: the CLI has no such session | agentId, sessionId, exitCode |  |
| `main/services/agent-system.ts:777` | warn | Ignoring a session id the CLI store does not have | agentId, sessionId |  |
| `main/services/agent-system.ts:788` | warn | Ignoring a scraped session id that is not this agent's | agentId, sessionId |  |
| `main/services/agent-system.ts:805` | warn | Resume failed: the CLI exited right away | agentId, sessionId, exitCode, runMs |  |
| `main/services/agent-system.ts:810` | info | No session ID on exit; keeping the previous one | agentId, exitCode, resumedSessionId |  |
| `main/services/agent-system.ts:822` | info | Captured session ID on exit | agentId, sessionId, exitCode |  |
| `main/services/agent-system.ts:826` | warn | Failed to persist session entry | agentId, sessionId, error |  |
| `main/services/agent-system.ts:832` | warn | Failed to capture session ID | agentId, error |  |
| `main/services/agent-system.ts:844` | warn | Failed to clear stale resume id | agentId, sessionId, error |  |
| `main/services/agent-system.ts:871` | info | Killing agent | agentId, trigger, waitForExit |  |
| `main/services/agent-system.ts:894` | warn | killAgent failed (process may already be dead) | agentId, error |  |
| `main/services/agent-system.ts:921` | `didExit ? 'info' : 'warn'` | `didExit ? 'Agent exited after kill' : 'Timed out waiting for agent exit after kill'` | agentId, waitedMs, sessionCaptured |  |
| `main/services/agent-system.ts:954` | warn | ``Profile "${profile.name}" has no config for orchestrator "${orchestratorId}" — spawning without profile env` | profileId, orchestratorId |  |
| `main/services/agent-system.ts:994` | warn | Failed to list provider sessions | agentId, error |  |
| `main/services/agent-system.ts:1027` | warn | Failed to prune missing sessions from history | agentId, error |  |

## core:agent-config (45)

| Location | Level | Message | meta | tel |
|---|---|---|---|---|
| `main/services/agent-config.ts:242` | warn | ``Reassigned ${reassigned.length} durable agent ID(s) already used by another project`` | projectPath, reassigned |  |
| `main/services/agent-config.ts:376` | error | Failed to read agent config file | filePath, error |  |
| `main/services/agent-config.ts:387` | debug | Reading agent configs from disk | configPath, backupPath |  |
| `main/services/agent-config.ts:408` | warn | ``Dropped ${parsed.length - valid.length} invalid record(s) from agents.json`` | configPath |  |
| `main/services/agent-config.ts:412` | info | ``Loaded ${agents.length} agent(s) from disk`` | configPath, agents |  |
| `main/services/agent-config.ts:422` | error | agents.json has no valid agent records — attempting recovery from backup | configPath |  |
| `main/services/agent-config.ts:429` | error | Failed to parse agents.json — attempting recovery from backup | configPath, error |  |
| `main/services/agent-config.ts:446` | warn | ``Recovered ${agents.length} agent(s) from backup`` | backupPath, agents |  |
| `main/services/agent-config.ts:459` | error | Backup agents.json.bak is also corrupt | backupPath, error |  |
| `main/services/agent-config.ts:467` | info | No agent configs found on disk | projectPath |  |
| `main/services/agent-config.ts:474` | warn | ``Agent config validation found ${issues.length} issue(s)`` | source, issues |  |
| `main/services/agent-config.ts:482` | warn | ``Removed ${removed.length} duplicate agent(s)`` | removedAgents |  |
| `main/services/agent-config.ts:493` | info | ``Removed legacy structuredMode from ${strippedLegacy} agent(s)`` | projectPath |  |
| `main/services/agent-config.ts:500` | warn | ``Repaired helper fields on ${normalizedHelpers} agent(s)`` | projectPath |  |
| `main/services/agent-config.ts:646` | info | ``Wrote ${agents.length} agent(s) to disk`` | configPath, agentIds, skippedBackup |  |
| `main/services/agent-config.ts:715` | warn | Failed to watch agents.json for external changes | projectPath, error |  |
| `main/services/agent-config.ts:721` | warn | Failed to watch agents.json for external changes | projectPath, error |  |
| `main/services/agent-config.ts:775` | warn | Detected external agents.json change; merging instead of overwriting it | projectPath |  |
| `main/services/agent-config.ts:799` | error | Failed to write agents.json | projectPath, error |  |
| `main/services/agent-config.ts:820` | error | Debounced agents.json flush failed | projectPath, error |  |
| `main/services/agent-config.ts:854` | info | ``Cache initialized with ${agents.length} agent(s)`` | projectPath, agentIds |  |
| `main/services/agent-config.ts:895` | warn | ``Agent count decreased: ${prevCount} → ${agents.length}`` | projectPath, removedAgents, caller |  |
| `main/services/agent-config.ts:934` | warn | Agent config change listener failed | projectPath, error |  |
| `main/services/agent-config.ts:957` | info | ``Flushing ${dirtyEntries.length} dirty cache(s) on shutdown`` | projects |  |
| `main/services/agent-config.ts:1058` | info | ``Restored ${missing.length} agent(s) from backup`` | projectPath, restoredIds |  |
| `main/services/agent-config.ts:1200` | warn | Persona change hook failed | agentId, error |  |
| `main/services/agent-config.ts:1539` | `error ? 'warn' : 'info'` | ``Kept the agent branch: ${why}`` | agentId, branch, ......(error ? { error: errorMessage(error) } : {}) |  |
| `main/services/agent-config.ts:1844` | info | Empty repository detected, creating initial commit for worktree support | agentName, projectPath |  |
| `main/services/agent-config.ts:1854` | warn | Failed to create initial commit in empty repository | agentName, projectPath, error |  |
| `main/services/agent-config.ts:1906` | error | Git worktree creation failed | agentName, branch, worktreePath, error |  |
| `main/services/agent-config.ts:1935` | warn | Failed to apply project agent defaults | agentName, error |  |
| `main/services/agent-config.ts:1945` | warn | Failed to inject config into the new agent | agentName, error |  |
| `main/services/agent-config.ts:1965` | info | Agent creation cancelled and cleaned up | agentId |  |
| `main/services/agent-config.ts:2059` | warn | Cleaning up an agent creation interrupted by a quit | projectPath, agentId, worktreePath, branch |  |
| `main/services/agent-config.ts:2097` | error | Failed to clean up an interrupted agent creation | projectPath, error |  |
| `main/services/agent-config.ts:2213` | warn | Git worktree removal failed, will clean up manually | agentId, worktreePath, error |  |
| `main/services/agent-config.ts:2301` | warn | Could not read worktree status | agentId, error |  |
| `main/services/agent-config.ts:2354` | warn | ``Push failed during ${isCleanupBranch ? 'cleanup-branch deletion' : 'delete-commit-push'}, work saved locally | agentId, ......(isCleanupBranch ? { cleanupBranch: branch } : { branch }), error |  |
| `main/services/agent-config.ts:2388` | error | Failed to commit during agent deletion | agentId, error |  |
| `main/services/agent-config.ts:2445` | error | Failed to create cleanup branch during agent deletion | agentId, error |  |
| `main/services/agent-config.ts:2525` | error | Failed to save patch file during agent deletion | agentId, savePath, error |  |
| `main/services/agent-config.ts:2577` | info | ``Kept ${released.length} helper(s) of a deleted agent as ordinary agents`` | deletedId, released |  |
| `main/services/agent-config.ts:3083` | error | Failed to dispose a helper | agentId, parentId, error |  |
| `main/services/agent-config.ts:3221` | `healthy ? 'info' : 'warn'` | Recovery audit complete | projectPath, diskAgentCount, runningAgentCount, healthy, ......(missingFromDisk.length > 0 ? { missingFromDisk } : {}),  |  |
| `main/services/agent-creation.ts:92` | warn | Agent creation failed | error |  |

## core:agent-settings (27)

| Location | Level | Message | meta | tel |
|---|---|---|---|---|
| `main/ipc/agent-settings-handlers.ts:24` | warn | ``Failed to resolve orchestrator conventions for ${projectPath}`` | error |  |
| `main/ipc/agent-settings-handlers.ts:224` | warn | ``Failed to get conventions for ${projectPath}`` | error |  |
| `main/services/agent-settings-service.ts:69` | warn | ``Failed to read CLAUDE.md at ${filePath}`` | error |  |
| `main/services/agent-settings-service.ts:93` | warn | ``Failed to parse MCP config from ${filePath}`` | error |  |
| `main/services/agent-settings-service.ts:125` | warn | ``Failed to list skills from ${skillsDir}`` | error |  |
| `main/services/agent-settings-service.ts:142` | warn | ``Failed to list agent templates from ${agentsDir}`` | error |  |
| `main/services/agent-settings-service.ts:163` | warn | ``Failed to read project settings from ${settingsFile} — failed to parse; attempting recovery from backup`` | error |  |
| `main/services/agent-settings-service.ts:171` | warn | ``Recovered project settings from backup ${backupFile}`` |  |  |
| `main/services/agent-settings-service.ts:175` | error | ``Failed to parse project settings backup from ${backupFile}`` | error |  |
| `main/services/agent-settings-service.ts:204` | warn | ``Failed to list source skills from ${skillsDir}`` | error |  |
| `main/services/agent-settings-service.ts:222` | warn | ``Failed to list source agent templates from ${agentsDir}`` | error |  |
| `main/services/agent-settings-service.ts:237` | warn | ``Failed to read source skill content at ${filePath}`` | error |  |
| `main/services/agent-settings-service.ts:276` | warn | ``Failed to list missions from ${missionsDir}`` | error |  |
| `main/services/agent-settings-service.ts:293` | warn | ``Failed to read mission "${missionId}" at ${filePath}`` | error |  |
| `main/services/agent-settings-service.ts:350` | warn | ``Failed to list personas from ${personasDir}`` | error |  |
| `main/services/agent-settings-service.ts:367` | warn | ``Failed to read persona "${personaId}" at ${filePath}`` | error |  |
| `main/services/agent-settings-service.ts:404` | warn | ``Failed to read source agent template at ${filePath}`` | error |  |
| `main/services/agent-settings-service.ts:509` | warn | ``Failed to read permissions from ${settingsPath}`` | error |  |
| `main/services/agent-settings-service.ts:525` | warn | ``Failed to read skill content at ${filePath}`` | error |  |
| `main/services/agent-settings-service.ts:563` | warn | ``Failed to read agent template "${agentName}" (tried .md and directory forms)`` | error |  |
| `main/services/agent-settings-service.ts:622` | warn | ``Failed to list agent template files from ${agentsDir}`` | error |  |
| `main/services/agent-settings-service.ts:638` | warn | `shadowWarning` | worktreePath, mcpConfigFile |  |
| `main/services/agent-settings-service.ts:646` | warn | ``Failed to read MCP config from ${filePath}`` | error |  |
| `main/services/agent-settings-service.ts:670` | warn | `shadowWarning` | worktreePath, mcpConfigFile |  |
| `main/services/agent-settings-service.ts:698` | warn | ``Failed to read existing settings at ${settingsPath}, starting fresh`` | error |  |
| `main/services/agent-settings-service.ts:746` | warn | Project default persona hook failed | error |  |
| `main/services/agent-settings-service.ts:802` | warn | Skipped invalid MCP config in agent defaults | error |  |

## core:agents (1)

| Location | Level | Message | meta | tel |
|---|---|---|---|---|
| `renderer/App.tsx:118` | error | Failed to load durable agents | error |  |

## core:annex (82)

| Location | Level | Message | meta | tel |
|---|---|---|---|---|
| `main/ipc/annex-handlers.ts:40` | info | Annex server started via settings |  |  |
| `main/ipc/annex-handlers.ts:42` | error | Failed to start Annex server | error |  |
| `main/ipc/annex-handlers.ts:48` | info | Annex server stopped via settings |  |  |
| `main/ipc/annex-handlers.ts:54` | info | Annex client started via settings |  |  |
| `main/ipc/annex-handlers.ts:57` | info | Annex client stopped via settings |  |  |
| `main/ipc/annex-handlers.ts:122` | info | Purging all Annex server configuration |  |  |
| `main/ipc/annex-handlers.ts:146` | info | Annex server configuration purged |  |  |
| `main/ipc/annex-handlers.ts:152` | info | Annex server startup check |  |  |
| `main/ipc/annex-handlers.ts:155` | info | Annex settings at startup | enableServer, enableClient, deviceName |  |
| `main/ipc/annex-handlers.ts:162` | info | Annex server auto-started on launch |  |  |
| `main/ipc/annex-handlers.ts:164` | error | Failed to auto-start Annex server | error |  |
| `main/ipc/annex-handlers.ts:178` | info | Annex client auto-started on launch |  |  |
| `main/ipc/annex-handlers.ts:180` | error | Failed to auto-start Annex client | error |  |
| `main/services/annex-identity.ts:118` | warn | Failed to back up corrupted Annex identity file | filePath, backupPath, error |  |
| `main/services/annex-identity.ts:140` | error | Annex identity file is corrupted or incomplete; regenerating a new identity | filePath, reason |  |
| `main/services/annex-identity.ts:152` | error | Annex identity file is corrupted or unreadable; regenerating a new identity | filePath, error |  |
| `main/services/annex-identity.ts:178` | info | Loaded existing Annex identity | fingerprint |  |
| `main/services/annex-identity.ts:189` | error | Your device identity was reset - re-pair your devices |  |  |
| `main/services/annex-identity.ts:199` | info | Generated new Annex identity | fingerprint |  |
| `main/services/annex-identity.ts:237` | info | Annex identity deleted |  |  |
| `main/services/annex-peers.ts:90` | info | Peer added/updated | fingerprint, alias |  |
| `main/services/annex-peers.ts:101` | info | Peer removed | fingerprint |  |
| `main/services/annex-peers.ts:107` | info | All peers removed |  |  |
| `main/services/annex-peers.ts:181` | warn | Pairing locked out | source, attempts |  |
| `main/services/annex-peers.ts:203` | info | Pairing unlocked | source |  |
| `main/services/annex-server.ts:362` | debug | Clipboard image cleanup failed (file may already be removed) | filePath, error |  |
| `main/services/annex-server.ts:492` | error | readBody failed | error |  |
| `main/services/annex-server.ts:772` | warn | broadcastWs: failed to send to client | error |  |
| `main/services/annex-server.ts:887` | warn | Agent did not register as running within timeout | agentId, maxAttempts, intervalMs |  |
| `main/services/annex-server.ts:1030` | error | Failed to spawn quick agent | agentId, error |  |
| `main/services/annex-server.ts:1063` | warn | Stale agent registration found during wake — cleaning up before respawn | agentId, existingRegistration |  |
| `main/services/annex-server.ts:1078` | warn | Agent config has missing or ghost name — using disk config name as-is | agentId, configName, configId |  |
| `main/services/annex-server.ts:1083` | info | Waking durable agent | agentId, agentName, projectId, projectPath, cwd, model, orchestrator, resume, hasWorktree |  |
| `main/services/annex-server.ts:1111` | info | Agent spawn completed successfully | agentId, agentName |  |
| `main/services/annex-server.ts:1142` | error | Failed to wake agent | agentId, agentName, error |  |
| `main/services/annex-server.ts:1316` | error | readBody failed | error |  |
| `main/services/annex-server.ts:1740` | error | Failed to send message to agent | agentId, mode, error |  |
| `main/services/annex-server.ts:2182` | warn | Rejected destructive REST request — mTLS required | method, url |  |
| `main/services/annex-server.ts:2227` | warn | Malformed JSON in WebSocket message | preview |  |
| `main/services/annex-server.ts:2340` | error | pty:spawn-shell lookup failed | projectId, error |  |
| `main/services/annex-server.ts:2360` | error | agent:spawn lookup failed | projectId, error |  |
| `main/services/annex-server.ts:2410` | error | Canvas mutation failed server-side | projectId, canvasId, mutationType, error |  |
| `main/services/annex-server.ts:2437` | error | agent:reorder lookup failed | projectId, error |  |
| `main/services/annex-server.ts:2511` | warn | Stale agent registration found during WS wake — cleaning up before respawn | agentId, existingRegistration |  |
| `main/services/annex-server.ts:2521` | info | Waking durable agent (WS) | agentId, agentName, projectId, cwd, model, orchestrator, resume |  |
| `main/services/annex-server.ts:2542` | info | Agent spawn completed successfully (WS) | agentId, agentName |  |
| `main/services/annex-server.ts:2556` | error | Failed to wake agent (WS) | agentId, agentName, error |  |
| `main/services/annex-server.ts:2569` | debug | Annex server start() called but already running |  |  |
| `main/services/annex-server.ts:2573` | info | Annex server starting... |  |  |
| `main/services/annex-server.ts:2578` | info | Annex identity ready | fingerprint |  |
| `main/services/annex-server.ts:2593` | warn | TLS server creation failed, falling back to plain HTTP | error |  |
| `main/services/annex-server.ts:2622` | warn | WebSocket upgrade rejected — invalid origin | origin, remoteAddress |  |
| `main/services/annex-server.ts:2652` | warn | WebSocket upgrade rejected — unauthorized | remoteAddress, hasToken |  |
| `main/services/annex-server.ts:2661` | info | WebSocket upgrade accepted | authType, peerFingerprint, remoteAddress |  |
| `main/services/annex-server.ts:2707` | info | WebSocket client disconnected | authType, code, reason |  |
| `main/services/annex-server.ts:2737` | error | Failed to send snapshot on connect | error |  |
| `main/services/annex-server.ts:2743` | debug | Failed to send error to client (client likely disconnected) | error |  |
| `main/services/annex-server.ts:2842` | info | Heartbeat: terminating unresponsive WebSocket client |  |  |
| `main/services/annex-server.ts:2858` | info | Creating Bonjour instance for mDNS advertisement... |  |  |
| `main/services/annex-server.ts:2871` | info | Publishing mDNS service | name, type, port, pairingPort |  |
| `main/services/annex-server.ts:2878` | error | Bonjour service error after publish | error, stack |  |
| `main/services/annex-server.ts:2883` | info | Bonjour service confirmed UP by mDNS stack |  |  |
| `main/services/annex-server.ts:2887` | info | mDNS service published (v2) | name, mainPort, pairingPort, fingerprint |  |
| `main/services/annex-server.ts:2894` | error | Failed to publish mDNS | error, stack |  |
| `main/services/annex-server.ts:2904` | info | ``Annex main server listening on 0.0.0.0:${serverPort} (${tlsServer ? 'TLS' : 'HTTP'})`` |  |  |
| `main/services/annex-server.ts:2915` | info | ``Annex pairing server listening on 0.0.0.0:${pairingPort} (HTTP)`` |  |  |
| `main/services/annex-server.ts:2943` | debug | Failed to close WebSocket client during shutdown | error |  |
| `main/services/annex-server.ts:2955` | debug | Failed to stop Bonjour service during shutdown | error |  |
| `main/services/annex-server.ts:2963` | debug | Failed to destroy Bonjour instance during shutdown | error |  |
| `main/services/annex-server.ts:2995` | info | Annex server stopped |  |  |
| `main/services/annex-server.ts:3024` | warn | broadcastSnapshotRefresh failed | error |  |
| `main/services/annex-server.ts:3042` | info | Running post-recovery audit | projectCount, runningAgentCount |  |
| `main/services/annex-server.ts:3328` | debug | Failed to close WebSocket client during pin regeneration | error |  |
| `main/services/annex-server.ts:3338` | info | disconnectPeer called | fingerprint |  |
| `main/services/annex-server.ts:3349` | debug | Failed to close peer WebSocket connection | fingerprint, error |  |
| `main/services/annex-tls.ts:125` | info | Loaded existing TLS certificate |  |  |
| `main/services/annex-tls.ts:131` | info | Generated new TLS certificate | cn |  |
| `main/services/annex-tls.ts:189` | info | Annex TLS certificate deleted |  |  |
| `main/services/preview-eligible.ts:8` | debug | Preview eligible: unpackaged (dev) build |  |  |
| `main/services/preview-eligible.ts:13` | debug | ``Preview eligible: prerelease version ${version}`` |  |  |
| `main/services/preview-eligible.ts:18` | debug | Preview eligible: preview channel enabled |  |  |
| `main/services/preview-eligible.ts:21` | debug | ``Not preview eligible: packaged stable build v${version}, preview channel off`` |  |  |

## core:annex-client (42)

| Location | Level | Message | meta | tel |
|---|---|---|---|---|
| `main/services/annex-client.ts:223` | warn | Agent buffer fetch failed | satelliteId, agentId, error |  |
| `main/services/annex-client.ts:288` | `error ? 'warn' : 'info'` | ``Satellite state: ${prev} → ${state}`` | fingerprint, alias, ......(error ? { error } : {}) |  |
| `main/services/annex-client.ts:374` | warn | Identity request failed | host, port, status |  |
| `main/services/annex-client.ts:380` | warn | Identity response missing fingerprint | host, port |  |
| `main/services/annex-client.ts:393` | warn | Identity request error | host, port, error |  |
| `main/services/annex-client.ts:422` | info | Bearer token expired, clearing for re-authentication | fingerprint |  |
| `main/services/annex-client.ts:433` | info | Connecting to satellite | fingerprint, host, port, hasBearerToken, authMode |  |
| `main/services/annex-client.ts:454` | warn | Refusing to send bearer token: peer certificate not verified | fingerprint, host, port |  |
| `main/services/annex-client.ts:484` | warn | Peer certificate is unavailable on the TLS socket; rejecting connection | fingerprint, host, port |  |
| `main/services/annex-client.ts:495` | warn | Peer certificate fingerprint mismatch | expected, actual, host, port |  |
| `main/services/annex-client.ts:511` | debug | Paired TLS socket verified; bearer token remains deferred until the next authenticated retry | fingerprint |  |
| `main/services/annex-client.ts:516` | info | Connected to satellite | fingerprint, host, port |  |
| `main/services/annex-client.ts:544` | warn | Malformed JSON from satellite | fingerprint, preview |  |
| `main/services/annex-client.ts:562` | info | Retrying connection with bearer token after TLS verification | fingerprint, host, port |  |
| `main/services/annex-client.ts:572` | `level` | WebSocket error | fingerprint, error, attempt |  |
| `main/services/annex-client.ts:659` | warn | Heartbeat pong timeout — closing connection | fingerprint | yes |
| `main/services/annex-client.ts:665` | debug | Failed to terminate WebSocket on heartbeat timeout | fingerprint, error |  |
| `main/services/annex-client.ts:698` | info | Auto-reconnect disabled, not scheduling | fingerprint |  |
| `main/services/annex-client.ts:708` | info | ``Scheduling reconnect in ${delay}ms (attempt ${sat.reconnectAttempt})`` | fingerprint, alias |  |
| `main/services/annex-client.ts:720` | info | Disconnecting satellite | fingerprint, alias, previousState |  |
| `main/services/annex-client.ts:730` | debug | Failed to close WebSocket during disconnect | fingerprint, error |  |
| `main/services/annex-client.ts:814` | info | Discovered paired satellite | fingerprint, alias, host, port |  |
| `main/services/annex-client.ts:839` | info | Discovered unpaired service | fingerprint, alias, host, port |  |
| `main/services/annex-client.ts:854` | info | Bonjour discovery started |  |  |
| `main/services/annex-client.ts:856` | error | Failed to start Bonjour discovery | error |  |
| `main/services/annex-client.ts:865` | debug | Failed to stop Bonjour browser | error |  |
| `main/services/annex-client.ts:873` | debug | Failed to destroy Bonjour instance | error |  |
| `main/services/annex-client.ts:903` | warn | Cannot connect — unknown peer | fingerprint |  |
| `main/services/annex-client.ts:935` | info | Satellite already connecting/connected | fingerprint |  |
| `main/services/annex-client.ts:957` | info | Forgetting satellite | fingerprint |  |
| `main/services/annex-client.ts:1001` | warn | sendToSatellite: send failed | fingerprint, error |  |
| `main/services/annex-client.ts:1044` | warn | File tree response JSON parse failed | fingerprint, error |  |
| `main/services/annex-client.ts:1050` | warn | File tree request failed | fingerprint, error |  |
| `main/services/annex-client.ts:1097` | warn | Per-channel read map too large for digest request; requesting without a cutoff | fingerprint, groupProjectId, channels |  |
| `main/services/annex-client.ts:1113` | warn | Bulletin digest response JSON parse failed | fingerprint, error |  |
| `main/services/annex-client.ts:1119` | warn | Bulletin digest request failed | fingerprint, error |  |
| `main/services/annex-client.ts:1149` | warn | Bulletin topic messages response JSON parse failed | fingerprint, error |  |
| `main/services/annex-client.ts:1155` | warn | Bulletin topic messages request failed | fingerprint, error |  |
| `main/services/annex-client.ts:1209` | warn | Bulletin all-messages response JSON parse failed | fingerprint, error |  |
| `main/services/annex-client.ts:1215` | warn | Bulletin all-messages request failed | fingerprint, error |  |
| `main/services/annex-client.ts:1625` | info | Paired with service | fingerprint, alias |  |
| `main/services/annex-client.ts:1640` | info | Forgetting all satellites |  |  |

## core:annex-server (3)

| Location | Level | Message | meta | tel |
|---|---|---|---|---|
| `main/services/annex-server.ts:351` | info | clipboard:image — wrote temp file | agentId, filePath, size |  |
| `main/services/annex-server.ts:368` | error | clipboard:image — failed to write temp file | agentId, error |  |
| `main/services/annex-server.ts:1868` | warn | Rejected bulletin digest request with invalid since | gpId, error |  |

## core:blueprint (10)

| Location | Level | Message | meta | tel |
|---|---|---|---|---|
| `main/ipc/blueprint-handlers.ts:110` | error | Failed to write blueprint to user-chosen path | filePath, error |  |
| `main/ipc/blueprint-handlers.ts:156` | error | Failed to open user-chosen blueprint file | filePath, error |  |
| `main/ipc/blueprint-handlers.ts:183` | error | Failed to read blueprints directory | path, error |  |
| `main/ipc/blueprint-handlers.ts:196` | warn | Skipping oversized blueprint file | filePath, sizeBytes, limitBytes |  |
| `main/ipc/blueprint-handlers.ts:206` | warn | Skipping invalid blueprint file | filePath, error |  |
| `main/ipc/blueprint-handlers.ts:225` | warn | Refusing to read oversized blueprint file | filePath, sizeBytes, limitBytes |  |
| `main/ipc/blueprint-handlers.ts:233` | error | Failed to read blueprint file | filePath, error |  |
| `main/ipc/blueprint-handlers.ts:250` | warn | Refusing to delete file outside allowed directories | filePath |  |
| `main/ipc/blueprint-handlers.ts:270` | warn | Refusing to delete file outside blueprints directory | filePath, resolved |  |
| `main/ipc/blueprint-handlers.ts:279` | error | Failed to delete blueprint file | filePath, error |  |

## core:canvas-index (2)

| Location | Level | Message | meta | tel |
|---|---|---|---|---|
| `main/ipc/canvas-index-handlers.ts:16` | warn | Rejected canvas index request — caller is not an application window |  |  |
| `main/services/canvas-store-reader.ts:185` | warn | Could not list projects for canvas stores | error |  |

## core:chat (34)

| Location | Level | Message | meta | tel |
|---|---|---|---|---|
| `main/services/agent-runtime/builtin-chat-drivers.ts:19` | `level` | `message` | `meta` |  |
| `main/services/agent-runtime/chat-driver-health.ts:108` | warn | Chat handshake probe failed | driver, provider, binary, elapsedMs, error, errorCode | yes |
| `main/services/agent-runtime/chat-runtime.ts:214` | info | Chat session open | agentId, driver, nativeSessionId, requestedResumeId, resumeHonored |  |
| `main/services/agent-runtime/chat-runtime.ts:534` | info | Abandoning chat start | agentId, driver, sessionOpen |  |
| `main/services/agent-runtime/chat-runtime.ts:549` | info | Stopping chat session | agentId, driver, nativeSessionId, sessionOpen |  |
| `main/services/agent-runtime/chat-runtime.ts:561` | warn | Driver close failed | agentId, error |  |
| `main/services/agent-runtime/chat-runtime.ts:722` | error | Transcript append failed | agentId, error |  |
| `main/services/agent-runtime/chat-runtime.ts:780` | info | Idle timeout reached; staying awake | agentId |  |
| `main/services/agent-runtime/chat-runtime.ts:838` | warn | Applying queued permission decision failed | agentId, requestId, error |  |
| `main/services/agent-runtime/chat-spawn.ts:115` | warn | `notice.message` | agentId, code |  |
| `main/services/agent-runtime/chat-spawn.ts:147` | info | `verdict.message` | driver, cliVersion |  |
| `main/services/agent-runtime/chat-spawn.ts:182` | info | Cancelling chat start | agentId, reason, runtimeRegistered |  |
| `main/services/agent-runtime/chat-spawn.ts:253` | info | No chat driver registered for provider; using the terminal | agentId, provider |  |
| `main/services/agent-runtime/chat-spawn.ts:263` | warn | CLI binary not found for chat; using the terminal | agentId, provider, error |  |
| `main/services/agent-runtime/chat-spawn.ts:274` | info | Cancelling chat start | agentId, reason, runtimeRegistered |  |
| `main/services/agent-runtime/chat-spawn.ts:290` | info | Chat start cancelled; not opening the terminal | agentId |  |
| `main/services/agent-runtime/chat-spawn.ts:319` | info | Chat start requested | agentId, provider, candidates, resumeSessionId, binaryPath, profileEnvKeys |  |
| `main/services/agent-runtime/chat-spawn.ts:340` | `check.ok ? 'info' : 'warn'` | Chat driver check | agentId, driver, ok, durationMs, ......(check.reason ? { reason: check.reason } : {}), ......(check.login ? { loginRequi |  |
| `main/services/agent-runtime/chat-spawn.ts:461` | warn | Failed to persist native session id | agentId, error |  |
| `main/services/agent-runtime/chat-spawn.ts:475` | info | Chat session ended | agentId, reason, exitCode |  |
| `main/services/agent-runtime/chat-spawn.ts:523` | info | Starting chat agent | agentId, provider, driver, level, resumed, resumeSessionId, continuedChatSession, mcpServers, env |  |
| `main/services/agent-runtime/chat-spawn.ts:561` | warn | Chat start failed | agentId, driver, error, sessionStarted |  |
| `main/services/agent-runtime/chat-transcript.ts:69` | warn | Could not clean up chat migration staging folders | error |  |
| `main/services/agent-runtime/chat-transcript.ts:153` | debug | Could not sync chat transcript folder | dir, error |  |
| `main/services/agent-runtime/chat-transcript.ts:310` | info | Imported chat events added to the legacy log after migration | agentId, imported |  |
| `main/services/agent-runtime/chat-transcript.ts:313` | warn | Skipped legacy chat events at or below their session's last seq; they remain in the legacy log | agentId, skipped, legacyFile |  |
| `main/services/agent-runtime/chat-transcript.ts:317` | warn | Could not import chat events added to the legacy log | agentId, error |  |
| `main/services/agent-runtime/chat-transcript.ts:381` | warn | Chat events saved; index update will be retried | agentId, error |  |
| `main/services/agent-runtime/chat-transcript.ts:407` | warn | Chat migration/index unavailable; persisting events before retry | agentId, retryInMs, error |  |
| `main/services/agent-runtime/chat-transcript.ts:424` | warn | Chat event saved; index update will be retried | agentId, error |  |
| `main/services/agent-runtime/checkpoint-tracker.ts:72` | warn | `message` | ......meta, error |  |
| `main/services/agent-runtime/checkpoint-tracker.ts:280` | info | Reverted turn | agentId, turnId, reverted, conflicts, skipped, force, backup, after |  |
| `main/services/agent-runtime/checkpoint-tracker.ts:298` | info | Undid revert | agentId, turnId, restored, conflicts, skipped |  |
| `main/services/agent-runtime/runtime-info.ts:46` | warn | Could not read the agent config to pick its runtime | agentId, error |  |

## core:chat:codex (1)

| Location | Level | Message | meta | tel |
|---|---|---|---|---|
| `main/services/agent-runtime/builtin-chat-drivers.ts:23` | `level` | `message` |  |  |

## core:chat:copilot (1)

| Location | Level | Message | meta | tel |
|---|---|---|---|---|
| `main/services/agent-runtime/builtin-chat-drivers.ts:26` | `level` | `message` |  |  |

## core:companion (6)

| Location | Level | Message | meta | tel |
|---|---|---|---|---|
| `main/ipc/agent-handlers.ts:923` | info | ``Companion agent already exists for ${pluginId}: ${existingId}`` |  |  |
| `main/services/companion-workspace.ts:50` | info | ``Companion workspace already exists for ${pluginId}`` | pluginId, path |  |
| `main/services/companion-workspace.ts:56` | info | ``Creating companion workspace for ${pluginId}`` | pluginId, path |  |
| `main/services/companion-workspace.ts:67` | info | ``Git initialized for companion workspace ${pluginId}`` |  |  |
| `main/services/companion-workspace.ts:69` | warn | ``Failed to initialize git for companion workspace ${pluginId}`` | error |  |
| `main/services/companion-workspace.ts:90` | info | ``Removing companion workspace for ${pluginId}`` | pluginId, path |  |

## core:config-diff (5)

| Location | Level | Message | meta | tel |
|---|---|---|---|---|
| `main/services/config-diff-service.ts:146` | warn | ``Failed to propagate item ${itemId}`` | error |  |
| `main/services/config-diff-service.ts:284` | warn | Failed to parse default MCP JSON for diff | error |  |
| `main/services/config-diff-service.ts:294` | warn | Failed to parse agent MCP config for diff | error |  |
| `main/services/config-diff-service.ts:499` | warn | Failed to parse default MCP JSON for propagation, starting fresh | error |  |
| `main/services/config-diff-service.ts:520` | warn | Failed to read agent MCP config for propagation | error |  |

## core:config-pipeline (15)

| Location | Level | Message | meta | tel |
|---|---|---|---|---|
| `main/services/config-pipeline.ts:47` | info | Snapshot saved | filePath, existed |  |
| `main/services/config-pipeline.ts:227` | info | Stripped Clubhouse hooks from stopped agent (deleted, no remaining settings) | filePath |  |
| `main/services/config-pipeline.ts:232` | info | Stripped Clubhouse hooks from stopped agent | filePath |  |
| `main/services/config-pipeline.ts:238` | error | Failed to strip hooks from stopped agent config | filePath, error |  |
| `main/services/config-pipeline.ts:291` | error | Failed to restore | filePath, error | yes |
| `main/services/config-pipeline.ts:305` | info | Restored (deleted, no remaining settings) | filePath |  |
| `main/services/config-pipeline.ts:308` | info | Restored (stripped Clubhouse hooks, preserved other settings) | filePath |  |
| `main/services/config-pipeline.ts:312` | info | Restored (deleted, not valid JSON) | filePath |  |
| `main/services/config-pipeline.ts:319` | info | Restored (stripped Clubhouse hooks) | filePath |  |
| `main/services/config-pipeline.ts:322` | info | Restored original (current file corrupt) | filePath |  |
| `main/services/config-pipeline.ts:335` | info | Restored TOML (deleted, no remaining config) | filePath |  |
| `main/services/config-pipeline.ts:338` | info | Restored TOML (stripped Clubhouse MCP, preserved other config) | filePath |  |
| `main/services/config-pipeline.ts:343` | info | Restored TOML (deleted, unreadable) | filePath |  |
| `main/services/config-pipeline.ts:351` | info | Restored TOML (stripped Clubhouse MCP) | filePath |  |
| `main/services/config-pipeline.ts:354` | info | Restored TOML original (current file unreadable) | filePath |  |

## core:feedback (5)

| Location | Level | Message | meta | tel |
|---|---|---|---|---|
| `main/ipc/feedback-handlers.ts:53` | info | Feedback shortcut ignored: feedback is not set up |  |  |
| `main/ipc/feedback-handlers.ts:59` | info | Feedback shortcut ignored: no main window to review in |  |  |
| `main/ipc/feedback-handlers.ts:72` | warn | Rejected feedback request: caller is not an application window |  |  |
| `main/menu.ts:60` | warn | Feedback shortcut capture failed | error |  |
| `main/services/framebriar/index.ts:44` | `level` | `msg` |  |  |

## core:file (10)

| Location | Level | Message | meta | tel |
|---|---|---|---|---|
| `main/ipc/file-handlers.ts:76` | error | Failed to read file | filePath, code, error |  |
| `main/ipc/file-handlers.ts:90` | error | Failed to write file | filePath, code, error |  |
| `main/ipc/file-handlers.ts:104` | error | Failed to read binary file | filePath, code, error |  |
| `main/ipc/file-handlers.ts:123` | error | Failed to create directory | dirPath, code, error |  |
| `main/ipc/file-handlers.ts:137` | error | Failed to delete file | filePath, code, error |  |
| `main/ipc/file-handlers.ts:152` | error | Failed to rename file | oldPath, newPath, code, error |  |
| `main/ipc/file-handlers.ts:167` | error | Failed to copy file | src, dest, code, error |  |
| `main/ipc/file-handlers.ts:181` | error | Failed to stat file | filePath, code, error |  |
| `main/ipc/file-handlers.ts:229` | error | Failed to open file in editor | filePath, editorCommand, error |  |
| `main/services/path-sandbox.ts:56` | error | Path access denied: outside allowed directories | targetPath, resolved |  |

## core:git (1)

| Location | Level | Message | meta | tel |
|---|---|---|---|---|
| `main/services/git-service.ts:85` | warn | Git operation failed | cmd, cwd, error |  |

## core:group-project (26)

| Location | Level | Message | meta | tel |
|---|---|---|---|---|
| `main/ipc/group-project-handlers.ts:27` | warn | Failed to broadcast group project changes | error |  |
| `main/ipc/group-project-handlers.ts:58` | info | Group project handlers registered |  |  |
| `main/ipc/group-project-handlers.ts:74` | info | Group project created | id, name |  |
| `main/ipc/group-project-handlers.ts:92` | info | Group project updated | id |  |
| `main/ipc/group-project-handlers.ts:106` | info | Group project deleted | id |  |
| `main/ipc/group-project-handlers.ts:220` | info | Cleared all messages | projectId, removed |  |
| `main/services/clubhouse-mcp/tools/group-project-tools.ts:569` | info | Agent woken via GP tool | agentId, projectPath, resume |  |
| `main/services/group-project-bulletin.ts:186` | error | Failed to parse bulletin board | projectId, error |  |
| `main/services/group-project-bulletin.ts:223` | error | Failed to write bulletin board | projectId, error |  |
| `main/services/group-project-bulletin.ts:597` | warn | Failed to remove bulletin data directory | projectId, dir |  |
| `main/services/group-project-lifecycle.ts:44` | warn | Chat injection failed | agentId, error |  |
| `main/services/group-project-lifecycle.ts:52` | info | PTY injection skipped: the agent is shutting down | agentId |  |
| `main/services/group-project-lifecycle.ts:59` | warn | PTY injection failed | agentId, error |  |
| `main/services/group-project-lifecycle.ts:84` | info | Group project lifecycle initialized |  |  |
| `main/services/group-project-lifecycle.ts:119` | warn | Failed to post leave event | agentId, projectId, error |  |
| `main/services/group-project-lifecycle.ts:141` | info | Suppressed spurious rejoin — agent not running | agentId, projectId, msSinceLeave |  |
| `main/services/group-project-lifecycle.ts:181` | warn | Failed to ensure project channels on join | agentId, projectId, error |  |
| `main/services/group-project-lifecycle.ts:190` | warn | Failed to create inbox channel | agentId, projectId, error |  |
| `main/services/group-project-lifecycle.ts:199` | warn | Failed to post join event | agentId, projectId, error |  |
| `main/services/group-project-polling.ts:74` | info | Sending polling start to member that was asleep when polling was turned on | agentId, projectId |  |
| `main/services/group-project-polling.ts:157` | info | Project polling setting changed | projectId, pollingEnabled, notified |  |
| `main/services/group-project-registry.ts:62` | error | Failed to parse group-projects registry | error |  |
| `main/services/group-project-registry.ts:90` | error | Failed to write group-projects registry | error |  |
| `main/services/group-project-registry.ts:129` | warn | Failed to seed project channels | projectId, error |  |
| `main/services/group-project-shoulder-tap.ts:166` | `stopping ? 'info' : 'error'` | `stopping ? 'Shoulder tap not delivered: the agent is shutting down' : 'Shoulder tap delivery failed'` | agentId, taskId, error |  |
| `main/services/group-project-shoulder-tap.ts:174` | info | Shoulder tap executed | projectId, taskId, senderLabel, deliveredCount, failedCount |  |

## core:headless (13)

| Location | Level | Message | meta | tel |
|---|---|---|---|---|
| `main/services/headless-manager.ts:96` | warn | Stale headless session detected, cleaning up | agentId, exitCode |  |
| `main/services/headless-manager.ts:155` | warn | Transcript memory cap reached, evicting old events | agentId, evictedCount, remaining, bytesFreed |  |
| `main/services/headless-manager.ts:362` | info | First JSONL event received | agentId, type |  |
| `main/services/headless-manager.ts:416` | info | First stdout data | agentId, bytes, preview |  |
| `main/services/headless-manager.ts:448` | warn | stderr | agentId, message |  |
| `main/services/headless-manager.ts:546` | info | Process exited | agentId, exitCode, signal, stdoutBytes, events, stderr |  |
| `main/services/headless-manager.ts:554` | info | Old process exited after session replacement — skipping cleanup | agentId, exitCode, signal |  |
| `main/services/headless-manager.ts:564` | error | Process error | agentId, error |  |
| `main/services/headless-manager.ts:603` | info | Spawning headless agent | agentId, binary, args, cwd, hasAnthropicKey |  |
| `main/services/headless-manager.ts:614` | error | Failed to spawn — no PID (binary may not exist) | agentId, binary |  |
| `main/services/headless-manager.ts:618` | info | Process spawned | agentId, pid |  |
| `main/services/headless-manager.ts:627` | error | transcript stream error | agentId, error |  |
| `main/services/headless-manager.ts:709` | warn | Headless runs did not all close before shutdown went on | runs, timeoutMs |  |

## core:hook-server (14)

| Location | Level | Message | meta | tel |
|---|---|---|---|---|
| `main/services/hook-server.ts:42` | info | ``Hook server ${value ? 'enabled' : 'disabled'}`` | enabled |  |
| `main/services/hook-server.ts:121` | warn | Rejected hook event — no nonce registered for agent | agentId |  |
| `main/services/hook-server.ts:125` | warn | Rejected hook event with invalid nonce | agentId |  |
| `main/services/hook-server.ts:206` | info | Permission hook decision sent to orchestrator | agentId, requestId, toolName, decision, queueResult, elapsedMs |  |
| `main/services/hook-server.ts:210` | error | Failed to write permission response | agentId, requestId, toolName, decision, elapsedMs, error, writableEnded |  |
| `main/services/hook-server.ts:244` | error | Permission decision promise rejected | agentId, requestId, toolName, error |  |
| `main/services/hook-server.ts:294` | warn | Hook event ignored (no project path for agent) | agentId, eventHint, orchestrator, bodyBytes |  |
| `main/services/hook-server.ts:310` | warn | Hook event ignored (provider not hook-capable) | agentId, eventHint, orchestrator, bodyBytes |  |
| `main/services/hook-server.ts:320` | warn | Hook event ignored (unknown event for orchestrator) | agentId, eventHint, orchestrator, rawEventName, bodyBytes |  |
| `main/services/hook-server.ts:334` | info | Hook event received | agentId, eventHint, orchestrator, kind, toolName, bodyBytes |  |
| `main/services/hook-server.ts:363` | error | Failed to parse hook event | agentId, eventHint, bodyBytes, error |  |
| `main/services/hook-server.ts:420` | info | ``Hook server listening on 127.0.0.1:${serverPort}`` | port |  |
| `main/services/hook-server.ts:431` | error | `err.message` |  |  |
| `main/services/hook-server.ts:437` | error | Hook server error | error, stack |  |

## core:hook-server-toggle (9)

| Location | Level | Message | meta | tel |
|---|---|---|---|---|
| `main/services/hook-server-toggle.ts:63` | error | Failed to strip hooks for agent | agentId, orchestrator, error |  |
| `main/services/hook-server-toggle.ts:77` | info | Hook server disabled for orchestrator — agents stripped of injected hooks | orchestrator, affectedAgentIds, agentCount |  |
| `main/services/hook-server-toggle.ts:117` | warn | Durable agent reconciliation skipped — failed to list projects | orchestrator, error |  |
| `main/services/hook-server-toggle.ts:132` | warn | Failed to list durable agents for project | projectPath, error |  |
| `main/services/hook-server-toggle.ts:151` | error | Failed to strip hooks for stopped durable agent | agentId, orchestrator, error |  |
| `main/services/hook-server-toggle.ts:181` | warn | Hook server enabled but server port is 0 — re-injection skipped | orchestrator |  |
| `main/services/hook-server-toggle.ts:191` | warn | Cannot re-inject hooks for agent — cwd unknown | agentId, orchestrator |  |
| `main/services/hook-server-toggle.ts:207` | error | Failed to re-inject hooks for agent | agentId, orchestrator, error |  |
| `main/services/hook-server-toggle.ts:213` | info | Hook server enabled for orchestrator — agents re-injected with hooks | orchestrator, affectedAgentIds, agentCount |  |

## core:ipc (5)

| Location | Level | Message | meta | tel |
|---|---|---|---|---|
| `main/ipc/agent-handlers.ts:673` | error | Agent spawn failed | agentId, kind, orchestrator, error, stack |  |
| `main/ipc/agent-handlers.ts:811` | warn | Failed to read session transcript | agentId, sessionId, error |  |
| `main/ipc/agent-handlers.ts:837` | warn | Failed to get session summary | agentId, sessionId, error |  |
| `main/ipc/agent-handlers.ts:867` | warn | Rejected permission decision (invalid value) | agentId, requestId, decision |  |
| `main/ipc/agent-handlers.ts:876` | warn | Rejected permission decision (unknown agent) | agentId, requestId, decision |  |

## core:materialization (8)

| Location | Level | Message | meta | tel |
|---|---|---|---|---|
| `main/ipc/agent-handlers.ts:316` | warn | Failed to refresh clubhouse-mode.md from LIST_DURABLE | projectPath, error |  |
| `main/services/materialization-service.ts:420` | warn | `shadowWarning` | agentName, mcpConfigFile |  |
| `main/services/materialization-service.ts:455` | warn | Skipping invalid MCP config during materialization | agentName |  |
| `main/services/materialization-service.ts:467` | info | ``Materialized settings for agent ${agent.name}`` | agentName, projectPath |  |
| `main/services/materialization-service.ts:499` | info | Removed stale JSON content from TOML config file | filePath |  |
| `main/services/materialization-service.ts:694` | info | ``Pruned stale skill "${entry.name}" from worktree`` |  |  |
| `main/services/materialization-service.ts:698` | info | ``Pruned stale agent template dir "${entry.name}" from worktree`` |  |  |
| `main/services/materialization-service.ts:701` | info | ``Pruned stale agent template file "${entry.name}" from worktree`` |  |  |

## core:mcp (97)

| Location | Level | Message | meta | tel |
|---|---|---|---|---|
| `main/ipc/mcp-binding-handlers.ts:55` | warn | Rejected MCP binding request — caller is not an application window |  |  |
| `main/ipc/mcp-binding-handlers.ts:87` | info | MCP binding handlers registered |  |  |
| `main/ipc/mcp-binding-handlers.ts:107` | debug | Creating binding for sleeping agent | agentId |  |
| `main/ipc/mcp-binding-handlers.ts:125` | `isNew ? 'info' : 'debug'` | `isNew ? 'Binding created' : 'Binding already present'` | agentId, agentName, targetId, targetName, targetKind |  |
| `main/ipc/mcp-binding-handlers.ts:146` | info | Binding kept on canvas cleanup: a persisted source still lists it | agentId, targetId |  |
| `main/ipc/mcp-binding-handlers.ts:157` | info | Binding removed | agentId, targetId |  |
| `main/ipc/mcp-binding-handlers.ts:177` | debug | Setting instructions for sleeping agent binding | agentId, targetId |  |
| `main/ipc/mcp-binding-handlers.ts:180` | info | Binding instructions updated | agentId, targetId |  |
| `main/ipc/mcp-binding-handlers.ts:191` | debug | Setting disabled tools for sleeping agent binding | agentId, targetId |  |
| `main/ipc/mcp-binding-handlers.ts:194` | info | Binding disabled tools updated | agentId, targetId, disabledTools |  |
| `main/ipc/mcp-binding-handlers.ts:236` | error | Failed to start MCP bridge server | error |  |
| `main/ipc/mcp-binding-handlers.ts:278` | error | Persisted binding rebuild failed | error |  |
| `main/ipc/plugin-mcp-handlers.ts:76` | warn | Ignoring rejected plugin tool result | error |  |
| `main/ipc/plugin-mcp-handlers.ts:82` | warn | Ignoring plugin tool result for a call that plugin does not own | pluginId |  |
| `main/ipc/plugin-mcp-handlers.ts:143` | warn | Rejected plugin MCP issuer claim: caller is not the plugin host | webContentsId, url |  |
| `main/services/agent-runtime/chat-spawn.ts:420` | warn | MCP bridge injection skipped for chat agent | agentId, error |  |
| `main/services/agent-system.ts:610` | warn | MCP bridge injection skipped | agentId, error |  |
| `main/services/canvas-wire-source.ts:39` | warn | Canvas store skipped for startup bindings; the canvas restores it when opened | store, problems |  |
| `main/services/canvas-wire-source.ts:60` | debug | Canvas wire is in more than one store; keeping the first | agentId, targetId, kept, ignored |  |
| `main/services/clubhouse-mcp/bridge-server.ts:138` | warn | Rejected MCP request — no nonce registered for agent | agentId |  |
| `main/services/clubhouse-mcp/bridge-server.ts:140` | warn | Rejected MCP request with invalid nonce | agentId |  |
| `main/services/clubhouse-mcp/bridge-server.ts:185` | info | Tools list requested | agentId, toolCount, toolNames |  |
| `main/services/clubhouse-mcp/bridge-server.ts:204` | info | Tool call | agentId, toolName, args |  |
| `main/services/clubhouse-mcp/bridge-server.ts:216` | `result.isError ? 'warn' : 'info'` | ``Tool call ${result.isError ? 'returned error' : 'completed'}`` | agentId, toolName, ......(errorText ? { errorDetail: errorText } : {}) |  |
| `main/services/clubhouse-mcp/bridge-server.ts:250` | error | Tool call threw exception | agentId, toolName, error |  |
| `main/services/clubhouse-mcp/bridge-server.ts:410` | info | Agent MCP connection initialized | agentId |  |
| `main/services/clubhouse-mcp/bridge-server.ts:498` | info | ``MCP bridge server listening on 127.0.0.1:${serverPort}`` | port |  |
| `main/services/clubhouse-mcp/bridge-server.ts:504` | error | `err.message` |  |  |
| `main/services/clubhouse-mcp/bridge-server.ts:510` | error | MCP bridge server error | error, stack |  |
| `main/services/clubhouse-mcp/bridge-server.ts:549` | info | MCP bridge server stopped |  |  |
| `main/services/clubhouse-mcp/injection.ts:173` | error | Bridge script not found | path |  |
| `main/services/clubhouse-mcp/injection.ts:280` | info | Injected Clubhouse MCP into TOML config | agentId, configPath |  |
| `main/services/clubhouse-mcp/injection.ts:319` | info | Injected Clubhouse MCP into config | agentId, configPath |  |
| `main/services/clubhouse-mcp/injection.ts:366` | info | Injected template MCP servers into config | cwd, serverNames, configPath |  |
| `main/services/clubhouse-mcp/plugin-tool-registry.ts:103` | info | ``Plugin ${pluginId} registered ${tools.length} MCP tools`` | pluginId, tools |  |
| `main/services/clubhouse-mcp/plugin-tool-registry.ts:128` | info | ``Plugin ${pluginId} removed ${existing.length} MCP tools`` |  |  |
| `main/services/clubhouse-mcp/tool-registry.ts:374` | info | Tool call refused: tool group is off for this agent | agentId, toolName, group |  |
| `main/services/clubhouse-mcp/tool-registry.ts:407` | warn | Tool call: failed to parse tool name | agentId, toolName |  |
| `main/services/clubhouse-mcp/tool-registry.ts:425` | warn | Tool call: no binding matches target | agentId, parsedToolKey, availableBindings |  |
| `main/services/clubhouse-mcp/tool-registry.ts:455` | info | Tool call refused: tool group is off for this agent | agentId, toolName, group |  |
| `main/services/clubhouse-mcp/tools/agent-tools.ts:105` | warn | send_message: target agent not found in registry | sourceAgent, targetAgent |  |
| `main/services/clubhouse-mcp/tools/agent-tools.ts:123` | info | send_message: target resolved | sourceAgent, targetAgent, runtime, taskId, senderLabel, isBidirectional |  |
| `main/services/clubhouse-mcp/tools/agent-tools.ts:142` | info | send_message: delivering | targetAgent, taskId, runtime, forceSubmit, messageLength |  |
| `main/services/clubhouse-mcp/tools/agent-tools.ts:157` | info | send_message: target is shutting down | sourceAgent, targetAgent, taskId |  |
| `main/services/clubhouse-mcp/tools/agent-tools.ts:160` | error | Failed to send message to agent | sourceAgent, targetAgent, error |  |
| `main/services/clubhouse-mcp/tools/agent-tools.ts:192` | info | get_status: resolved | sourceAgent, targetAgent, ......status |  |
| `main/services/clubhouse-mcp/tools/agent-tools.ts:228` | warn | read_output: target agent not found in registry | sourceAgent, targetAgent |  |
| `main/services/clubhouse-mcp/tools/agent-tools.ts:304` | info | check_connectivity: resolved | sourceAgent, targetAgent, direction |  |
| `main/services/clubhouse-mcp/tools/agent-tools.ts:387` | info | send_file: file written | sourceAgent, targetAgent, taskId, filePath, contentLength |  |
| `main/services/clubhouse-mcp/tools/agent-tools.ts:412` | info | send_file: target is shutting down | sourceAgent, targetAgent, taskId |  |
| `main/services/clubhouse-mcp/tools/agent-tools.ts:415` | error | send_file failed | sourceAgent, targetAgent, error |  |
| `main/services/clubhouse-mcp/tools/agent-tools.ts:451` | info | clear_agent: /clear sent | sourceAgent, targetAgent |  |
| `main/services/clubhouse-mcp/tools/agent-tools.ts:487` | info | compact_agent: /compact sent | sourceAgent, targetAgent |  |
| `main/services/clubhouse-mcp/tools/browser-tools.ts:54` | debug | Webview registered | widgetId, webContentsId |  |
| `main/services/clubhouse-mcp/tools/browser-tools.ts:69` | warn | Widget lookup failed — not in registry | widgetId, registeredWidgets |  |
| `main/services/clubhouse-mcp/tools/browser-tools.ts:76` | warn | Widget lookup failed — webContents destroyed | widgetId, webContentsId |  |
| `main/services/clubhouse-mcp/tools/browser-tools.ts:122` | error | Failed to attach debugger | webContentsId, error |  |
| `main/services/clubhouse-mcp/tools/browser-tools.ts:153` | warn | Browser tool rejected — agent not bound to widget | agentId, widgetId |  |
| `main/services/clubhouse-mcp/tools/browser-tools.ts:390` | warn | User denied browser evaluate | agentId, targetId, expression |  |
| `main/services/clubhouse-mcp/tools/connection-tools.ts:200` | error | ``${tool} failed`` | agentId, error |  |
| `main/services/clubhouse-mcp/tools/connection-tools.ts:234` | info | Orchestrator created a group project | agentId, groupProjectId, members |  |
| `main/services/clubhouse-mcp/tools/helper-tools.ts:105` | warn | ``${tool} failed`` | agentId, error |  |
| `main/services/clubhouse-mcp/tools/helper-tools.ts:168` | warn | Helper update not delivered: the orchestrator is not running | orchestratorId, delivery |  |
| `main/services/clubhouse-mcp/tools/helper-tools.ts:173` | warn | Helper update not delivered | orchestratorId, error |  |
| `main/services/clubhouse-mcp/tools/helper-tools.ts:261` | warn | Could not save a helper's undelivered task | helperId, error |  |
| `main/services/clubhouse-mcp/tools/helper-tools.ts:321` | info | start_helper: helper left asleep | orchestratorId, helperId, reason |  |
| `main/services/clubhouse-mcp/tools/helper-tools.ts:348` | info | start_helper: helper started | orchestratorId, helperId, access |  |
| `main/services/clubhouse-mcp/tools/helper-tools.ts:360` | warn | start_helper: helper spawn failed | orchestratorId, helperId, error |  |
| `main/services/clubhouse-mcp/tools/helper-tools.ts:446` | info | start_helper refused by the helper limit | agentId, reason, helperCount, maxHelpers |  |
| `main/services/clubhouse-mcp/tools/helper-tools.ts:474` | info | start_helper needs user approval | agentId, control, requestId, reused |  |
| `main/services/clubhouse-mcp/tools/helper-tools.ts:505` | warn | start_helper: persona not applied | helperId, persona, error |  |
| `main/services/clubhouse-mcp/tools/helper-tools.ts:523` | error | start_helper: background start failed | helperId, error |  |
| `main/services/clubhouse-mcp/tools/helper-tools.ts:528` | info | start_helper: creating helper | agentId, helperId, access, clamped, approved |  |
| `main/services/clubhouse-mcp/tools/helper-tools.ts:630` | info | Approved helper start refused | orchestratorId, requestId, reason |  |
| `main/services/clubhouse-mcp/tools/helper-tools.ts:639` | info | Helper start declined | orchestratorId, requestId |  |
| `main/services/clubhouse-mcp/tools/helper-tools.ts:653` | info | Held helper starts dropped | orchestratorId, count, reason |  |
| `main/services/clubhouse-mcp/tools/helper-tools.ts:659` | warn | Could not check held helper starts | orchestratorId, error |  |
| `main/services/clubhouse-mcp/tools/helper-tools.ts:797` | warn | sleep_helper: helper has not exited | agentId, helperId |  |
| `main/services/clubhouse-mcp/tools/helper-tools.ts:804` | info | sleep_helper: helper put to sleep | agentId, helperId |  |
| `main/services/clubhouse-mcp/tools/helper-tools.ts:892` | info | wake_helper: helper woken | agentId, helperId, resume, access |  |
| `main/services/clubhouse-mcp/tools/helper-tools.ts:915` | info | message_parent: delivered | agentId, parentId, length |  |
| `main/services/clubhouse-mcp/tools/notify-tools.ts:75` | info | notify_user: agent requested user attention | agentId, hasTitle |  |
| `main/services/helper-wire-source.ts:81` | warn | Could not read agents for helper wires; keeping that project's wires as they are | projectPath, error |  |
| `main/services/helper-wire-source.ts:135` | warn | Could not read agents after a config change | projectPath, error |  |
| `main/services/helper-wire-source.ts:148` | warn | Helper wire rebuild failed | error |  |
| `main/services/helper-wire-source.ts:158` | warn | Helper wires still out of date after retries; the next agent change retries | projects |  |
| `main/services/orchestrator-connections.ts:76` | warn | Orchestrator connections file was unreadable; moved it aside and continued with none | file, movedTo, reason |  |
| `main/services/orchestrator-connections.ts:302` | warn | Could not read orchestrator connections; keeping that project's connections as they are | projectPath, error |  |
| `main/services/orchestrator-connections.ts:356` | info | Dropped orchestrator connections that fell out of scope | projectPath, removed |  |
| `main/services/orchestrator-connections.ts:362` | warn | Could not update orchestrator connections after an agent change | projectPath, error |  |
| `main/services/orchestrator-connections.ts:378` | warn | Orchestrator connection rebuild failed | error |  |
| `main/services/orchestrator-connections.ts:389` | info | Dropped orchestrator connections the user removed | agentId, targetId, dropped |  |
| `main/services/orchestrator-connections.ts:393` | warn | Could not drop a user-removed orchestrator connection | agentId, targetId, error |  |
| `main/services/persisted-bindings.ts:171` | warn | User-removal listener failed | agentId, targetId, error |  |
| `main/services/persisted-bindings.ts:400` | warn | Persisted binding source failed; its bindings wait for the renderer | source, error |  |
| `main/services/persisted-bindings.ts:480` | warn | Persisted binding source afterRebuild failed | source, error |  |
| `main/services/persisted-bindings.ts:486` | info | Persisted bindings rebuilt | sources |  |

## core:orchestration (13)

| Location | Level | Message | meta | tel |
|---|---|---|---|---|
| `main/ipc/agent-handlers.ts:135` | warn | Dispose decision not delivered | orchestratorId, error |  |
| `main/services/agent-system.ts:178` | warn | Could not resolve a helper's ceiling; starting it at standard | agentId, orchestratorId, error |  |
| `main/services/agent-system.ts:185` | info | Lowered a helper's launch access to its orchestrator's ceiling | agentId, orchestratorId, asked, level |  |
| `main/services/clubhouse-mcp/tools/helper-dispose-tools.ts:167` | info | Helper handed off | orchestratorId, helperId, how |  |
| `main/services/clubhouse-mcp/tools/helper-dispose-tools.ts:234` | info | Helper dispose sent to the user (ask-everything) | orchestratorId, helperId, forceRequested, delivered |  |
| `main/services/clubhouse-mcp/tools/helper-dispose-tools.ts:309` | info | Helper disposed by its orchestrator | orchestratorId, helperId, forced |  |
| `main/services/orchestration-policy.ts:123` | warn | Could not read orchestration defaults from a persona | personaId, error |  |
| `main/services/orchestration-policy.ts:221` | warn | Could not read the orchestration policy; orchestration is off for this run | agentId, error |  |
| `main/services/orchestration-policy.ts:272` | info | Orchestration policy changed | agentId, orchestrate, access, control, maxHelpers |  |
| `main/services/orchestration-policy.ts:355` | warn | Helpers started during turn-off could not be settled | agentId, choice, helperIds |  |
| `main/services/orchestration-policy.ts:363` | info | Orchestration turned off | agentId, choice, helpers |  |
| `main/services/orchestration-policy.ts:392` | info | Persona change kept orchestration on: the agent has helpers | agentId, helpers |  |
| `main/services/orchestration-policy.ts:492` | warn | Skipped a project while counting helpers | projectPath, error |  |

## core:orchestrator (10)

| Location | Level | Message | meta | tel |
|---|---|---|---|---|
| `main/orchestrators/claude-code-provider.ts:341` | warn | Failed to stat session file | file, error |  |
| `main/orchestrators/claude-code-provider.ts:347` | warn | Failed to read session directory | dir, error |  |
| `main/orchestrators/claude-code-provider.ts:399` | warn | Failed to read session directory entries | dirPath, error |  |
| `main/orchestrators/claude-code-provider.ts:410` | warn | Failed to read session transcript | jsonlPath |  |
| `main/orchestrators/codex-cli-provider.ts:407` | warn | Skipping MCP server with a name Codex cannot key on | name |  |
| `main/orchestrators/codex-cli-provider.ts:655` | warn | Failed to scan Codex session store | sessionsDir, error |  |
| `main/orchestrators/codex-cli-provider.ts:724` | warn | Failed to read session transcript | filePath |  |
| `main/orchestrators/copilot-cli-provider.ts:389` | warn | Failed to read GHCP session store | error |  |
| `main/orchestrators/copilot-cli-provider.ts:466` | warn | Failed to read GHCP session directory entries | dirPath, error |  |
| `main/orchestrators/copilot-cli-provider.ts:477` | warn | Failed to read GHCP session transcript | filePath |  |

## core:permission-queue (10)

| Location | Level | Message | meta | tel |
|---|---|---|---|---|
| `main/services/annex-permission-queue.ts:74` | warn | Permission timed out | requestId, agentId, toolName, timeoutMs |  |
| `main/services/annex-permission-queue.ts:94` | info | Permission requested | requestId, agentId, toolName, timeoutMs, deadline, hasInput, hasMessage |  |
| `main/services/annex-permission-queue.ts:150` | warn | Permission resolve no-op (unknown or already resolved) | requestId, decision, source |  |
| `main/services/annex-permission-queue.ts:158` | error | Permission resolve rejected (agent mismatch) | requestId, decision, source, claimedAgentId, ownerAgentId |  |
| `main/services/annex-permission-queue.ts:165` | warn | Permission resolve rejected (deadline passed) | requestId, decision, source, agentId, createdAt, timeoutMs |  |
| `main/services/annex-permission-queue.ts:174` | info | Permission resolved | requestId, agentId, toolName, decision, elapsedMs, source |  |
| `main/services/annex-permission-queue.ts:237` | info | Permission withdrawn | requestId, agentId, toolName, reason |  |
| `main/services/annex-permission-queue.ts:256` | info | Permissions cleared on agent stop | agentId, count |  |
| `main/services/annex-permission-queue.ts:272` | debug | Permission queue reset | count |  |
| `main/services/hook-server.ts:395` | warn | Stuck pending permission | requestId, agentId, toolName, ageMs, timeoutMs, remainingMs |  |

## core:plugin-events (1)

| Location | Level | Message | meta | tel |
|---|---|---|---|---|
| `renderer/plugins/plugin-events.ts:29` | error | ``Error in event handler for "${event}"`` | event, error, stack |  |

## core:plugin-storage (3)

| Location | Level | Message | meta | tel |
|---|---|---|---|---|
| `main/services/plugin-storage.ts:64` | error | Path traversal attempt blocked | base, target, resolved |  |
| `main/services/plugin-storage.ts:74` | error | Symlink path traversal attempt blocked | base, target, resolved, realTarget |  |
| `main/services/plugin-storage.ts:176` | warn | Plugin storage key is unreadable | pluginId, key, error |  |

## core:plugins (57)

| Location | Level | Message | meta | tel |
|---|---|---|---|---|
| `main/index.ts:340` | warn | clubhouse-plugin: request denied | url, error |  |
| `main/index.ts:393` | warn | ``Retired plugin cleanup failed: ${err instanceof Error ? err.message : String(err)}`` |  |  |
| `main/services/plugin-manifest-registry.ts:109` | warn | Skipping invalid community plugin manifest for security policy | pluginPath, errors |  |
| `main/services/retired-plugin-cleanup.ts:72` | warn | ``Failed to clean up data for retired plugin "${pluginId}"`` | pluginId, error |  |
| `main/services/retired-plugin-cleanup.ts:82` | warn | Failed to remove data for a retired feature | dir, error |  |
| `main/services/retired-plugin-cleanup.ts:89` | info | Removed data left by retired built-in features | removed |  |
| `renderer/app-initializer.ts:74` | error | Failed to initialize plugin system | error, stack |  |
| `renderer/App.tsx:226` | error | Project switch error | error, stack |  |
| `renderer/panels/PluginContentView.tsx:29` | error | ``Plugin "${pluginId}" render error`` | pluginId, error, stack |  |
| `renderer/plugins/plugin-api-shared.ts:55` | error | ``Permission violation: plugin '${pluginId}' tried to use api.${apiName} without '${permission}' permission`` |  |  |
| `renderer/plugins/plugin-api-shared.ts:71` | error | ``Failed to disable plugin '${pluginId}' after permission violation`` | error |  |
| `renderer/plugins/plugin-loader.ts:120` | error | ``Giving up on activating "${pluginId}" after ${attempts} attempts`` | pluginId, projectId, attempts |  |
| `renderer/plugins/plugin-loader.ts:142` | warn | ``Scheduling activation retry for "${pluginId}" in ${delay}ms`` | pluginId, projectId, attempts, delay |  |
| `renderer/plugins/plugin-loader.ts:178` | info | ``Manual activation retry for "${pluginId}"`` | pluginId, projectId |  |
| `renderer/plugins/plugin-loader.ts:248` | warn | Safe mode active — no plugins will be loaded |  |  |
| `renderer/plugins/plugin-loader.ts:253` | info | Initializing plugin system |  |  |
| `renderer/plugins/plugin-loader.ts:321` | warn | ``Plugin "${result.manifest.name}" (${result.manifest.id}): ${result.warnings.join('; ')}`` | pluginId, warnings |  |
| `renderer/plugins/plugin-loader.ts:326` | warn | ``Community plugin incompatible: ${pluginPath}`` | pluginPath, errors |  |
| `renderer/plugins/plugin-loader.ts:332` | warn | ``Skipping plugin with empty ID: ${pluginPath}`` | pluginPath |  |
| `renderer/plugins/plugin-loader.ts:346` | error | Community plugin discovery failed | error |  |
| `renderer/plugins/plugin-loader.ts:377` | info | Removed retired built-in plugins from app-enabled list |  |  |
| `renderer/plugins/plugin-loader.ts:393` | info | Migrated canvas from experimental flag to app-enabled |  |  |
| `renderer/plugins/plugin-loader.ts:419` | info | ``Cleared stale '${k}' experimental flag`` |  |  |
| `renderer/plugins/plugin-loader.ts:463` | info | Plugin system initialized | pluginCount, activeCount, appEnabled |  |
| `renderer/plugins/plugin-loader.ts:467` | error | Plugin system initialization failed | error |  |
| `renderer/plugins/plugin-loader.ts:544` | error | ``Cannot activate unknown plugin: ${pluginId}`` |  |  |
| `renderer/plugins/plugin-loader.ts:549` | warn | ``Skipping activation of ${pluginId}: ${entry.status}`` | pluginId, status, error |  |
| `renderer/plugins/plugin-loader.ts:562` | warn | ``Skipping activation of ${pluginId}: errored, retries exhausted`` | pluginId, status, error, attempts |  |
| `renderer/plugins/plugin-loader.ts:568` | debug | ``Deferring activation of ${pluginId}: retry already scheduled`` | pluginId, attempts, nextEligibleAt |  |
| `renderer/plugins/plugin-loader.ts:580` | warn | ``Skipping activation of project-scoped plugin "${pluginId}" without project context`` |  |  |
| `renderer/plugins/plugin-loader.ts:627` | warn | ``Timed out reading settings for plugin "${pluginId}"`` | pluginId, projectId, timeoutMs |  |
| `renderer/plugins/plugin-loader.ts:651` | info | ``Pack plugin "${pluginId}" activated`` | pluginId, themes |  |
| `renderer/plugins/plugin-loader.ts:658` | error | ``Built-in plugin ${pluginId} has no module`` |  |  |
| `renderer/plugins/plugin-loader.ts:680` | error | ``Failed to load module for plugin "${pluginId}"`` | pluginId, modulePath, moduleUrl, error, stack |  |
| `renderer/plugins/plugin-loader.ts:695` | error | `errMsg` | pluginId, modulePath |  |
| `renderer/plugins/plugin-loader.ts:719` | warn | ``Failed to create data directory for plugin "${pluginId}"`` |  |  |
| `renderer/plugins/plugin-loader.ts:732` | warn | ``Failed to create workspace directory for plugin "${pluginId}"`` |  |  |
| `renderer/plugins/plugin-loader.ts:779` | error | ``Error activating plugin "${pluginId}"`` | pluginId, source, error, stack |  |
| `renderer/plugins/plugin-loader.ts:807` | error | ``Error disposing subscription for ${pluginId}`` | pluginId, error |  |
| `renderer/plugins/plugin-loader.ts:838` | error | ``Error in deactivate for ${pluginId}`` | pluginId, error |  |
| `renderer/plugins/plugin-loader.ts:904` | error | ``Cannot hot-reload unknown plugin: ${pluginId}`` |  |  |
| `renderer/plugins/plugin-loader.ts:909` | warn | ``Cannot hot-reload built-in plugin: ${pluginId}`` |  |  |
| `renderer/plugins/plugin-loader.ts:913` | info | ``Hot-reloading plugin: ${pluginId}`` |  |  |
| `renderer/plugins/plugin-loader.ts:957` | error | ``Plugin ${pluginId} no longer found at ${entry.pluginPath}`` |  |  |
| `renderer/plugins/plugin-loader.ts:964` | error | ``Updated plugin ${pluginId} has invalid manifest`` | errors |  |
| `renderer/plugins/plugin-loader.ts:981` | warn | ``Plugin ${pluginId} update requires new permissions`` | pluginId, newVersion, addedPermissions |  |
| `renderer/plugins/plugin-loader.ts:1036` | warn | ``Plugin ${pluginId} hot-reloaded with activation errors`` | newVersion, status, errors |  |
| `renderer/plugins/plugin-loader.ts:1042` | info | ``Plugin ${pluginId} hot-reloaded successfully`` | newVersion, status |  |
| `renderer/plugins/plugin-loader.ts:1057` | warn | ``Cannot approve permissions for ${pluginId}: not pending`` |  |  |
| `renderer/plugins/plugin-loader.ts:1064` | info | ``Permissions approved for ${pluginId}, activating`` |  |  |
| `renderer/plugins/plugin-loader.ts:1094` | info | ``Permissions rejected for ${pluginId}, plugin disabled`` |  |  |
| `renderer/plugins/plugin-loader.ts:1118` | info | ``Discovered new plugin: ${result.manifest.id}`` | pluginPath, source |  |
| `renderer/plugins/plugin-loader.ts:1122` | warn | ``New plugin incompatible: ${pluginPath}`` | pluginPath, errors |  |
| `renderer/plugins/plugin-loader.ts:1196` | info | ``Discovered new plugin: ${id}`` | pluginPath, source |  |
| `renderer/plugins/plugin-loader.ts:1261` | warn | ``Plugin "${id}" is now incompatible`` | pluginId, pluginPath, errors |  |
| `renderer/plugins/plugin-loader.ts:1269` | info | Community plugins refreshed | ......result |  |
| `renderer/plugins/plugin-mcp-host.ts:129` | warn | Could not claim the plugin MCP issuer; plugin MCP tools are unavailable | error |  |

## core:process (2)

| Location | Level | Message | meta | tel |
|---|---|---|---|---|
| `main/index.ts:131` | fatal | Uncaught exception | error, stack |  |
| `main/index.ts:139` | error | Unhandled promise rejection | error, stack |  |

## core:project (15)

| Location | Level | Message | meta | tel |
|---|---|---|---|---|
| `main/ipc/project-handlers.ts:27` | warn | ensureGitignore failed (non-fatal) | dirPath, error |  |
| `main/ipc/project-handlers.ts:61` | error | git init failed | dirPath, error |  |
| `main/ipc/project-handlers.ts:142` | error | Failed to list .clubhouse files | projectPath, error |  |
| `main/ipc/project-handlers.ts:158` | warn | Resetting project .clubhouse directory | projectPath |  |
| `main/ipc/project-handlers.ts:164` | error | Failed to reset project directory | projectPath, error |  |
| `main/ipc/project-handlers.ts:176` | error | Failed to read launch wrapper | projectPath, error |  |
| `main/ipc/project-handlers.ts:191` | error | Failed to write launch wrapper | projectPath, error |  |
| `main/ipc/project-handlers.ts:203` | error | Failed to read MCP catalog | projectPath, error |  |
| `main/ipc/project-handlers.ts:215` | error | Failed to write MCP catalog | projectPath, error |  |
| `main/ipc/project-handlers.ts:227` | error | Failed to read default MCPs | projectPath, error |  |
| `main/ipc/project-handlers.ts:239` | error | Failed to write default MCPs | projectPath, error |  |
| `main/ipc/project-handlers.ts:250` | error | Failed to read MCP configs | projectPath, error |  |
| `main/ipc/project-handlers.ts:261` | error | Failed to write MCP configs | projectPath, error |  |
| `main/ipc/project-handlers.ts:272` | error | Failed to read wrapper catalog snapshot | projectPath, error |  |
| `main/ipc/project-handlers.ts:283` | error | Failed to write wrapper catalog snapshot | projectPath, error |  |

## core:project-store (11)

| Location | Level | Message | meta | tel |
|---|---|---|---|---|
| `main/services/project-store.ts:235` | debug | Reading project store from disk | storePath, backupPath |  |
| `main/services/project-store.ts:248` | warn | ``Dropped ${dropped} malformed project entr${dropped === 1 ? 'y' : 'ies'} from projects.json`` | storePath, dropped |  |
| `main/services/project-store.ts:252` | info | ``Loaded ${store.projects.length} project(s) from disk`` | storePath, projects |  |
| `main/services/project-store.ts:257` | info | Migrated project store from older format | fromVersion, toVersion |  |
| `main/services/project-store.ts:263` | error | Failed to parse or validate projects.json — quarantining and attempting recovery from backup | storePath, error |  |
| `main/services/project-store.ts:272` | info | Corrupt projects.json quarantined | corrupted, quarantined |  |
| `main/services/project-store.ts:276` | error | Failed to quarantine corrupt projects.json | storePath, error |  |
| `main/services/project-store.ts:290` | warn | ``Recovered ${store.projects.length} project(s) from backup`` | backupPath, projects |  |
| `main/services/project-store.ts:301` | error | Backup projects.json.bak is also corrupt | backupPath, error |  |
| `main/services/project-store.ts:308` | info | No project store found on disk, starting with empty list | storePath, backupPath |  |
| `main/services/project-store.ts:341` | info | ``Wrote ${store.projects.length} project(s) to disk`` | storePath, projectIds |  |

## core:protocol (3)

| Location | Level | Message | meta | tel |
|---|---|---|---|---|
| `main/services/protocol-service.ts:46` | error | Failed to list projects for protocol dispatch | error |  |
| `main/services/protocol-service.ts:54` | warn | Ignoring unrecognized protocol URL | url |  |
| `main/services/protocol-service.ts:58` | info | ``Protocol activation: ${action.kind}`` | url |  |

## core:pty (6)

| Location | Level | Message | meta | tel |
|---|---|---|---|---|
| `main/services/pty-manager.ts:157` | warn | Stale PTY session detected, cleaning up | agentId, pid |  |
| `main/services/pty-manager.ts:349` | error | Failed to spawn PTY process | agentId, binary, cwd, error |  |
| `main/services/pty-manager.ts:390` | `exitCode !== 0 && !current.killing ? 'error' : 'info'` | PTY exited | agentId, exitCode, binary, lastOutput |  |
| `main/services/pty-manager.ts:428` | error | Failed to spawn shell PTY | sessionId, cwd, error |  |
| `main/services/pty-manager.ts:492` | warn | Oversized PTY write rejected | agentId, length, limit |  |
| `main/services/pty-manager.ts:512` | warn | Oversized PTY binary write rejected | agentId, length, limit |  |

## core:renderer (1)

| Location | Level | Message | meta | tel |
|---|---|---|---|---|
| `renderer/components/AppErrorBoundary.tsx:30` | error | App render error | error, stack, componentStack |  |

## core:resume (1)

| Location | Level | Message | meta | tel |
|---|---|---|---|---|
| `renderer/app-initializer.ts:127` | error | Failed to check pending resumes | error |  |

## core:safe-mode (4)

| Location | Level | Message | meta | tel |
|---|---|---|---|---|
| `main/services/safe-mode.ts:61` | warn | Startup crash loop detected, prompting safe mode | attempt, lastEnabledPlugins |  |
| `main/services/safe-mode.ts:75` | warn | User chose safe mode — disabling all plugins |  |  |
| `main/services/safe-mode.ts:78` | info | User chose to try again normally |  |  |
| `main/services/safe-mode.ts:107` | warn | Safe mode activated — disabling all plugins |  |  |

## core:security (4)

| Location | Level | Message | meta | tel |
|---|---|---|---|---|
| `main/window-security-guards.ts:19` | warn | ``Blocked navigation to external URL: ${url}`` |  |  |
| `main/window-security-guards.ts:26` | warn | ``Blocked window.open to external URL: ${url}`` |  |  |
| `main/window-security-guards.ts:50` | info | Blocked file:// webview — enable "Allow local file webviews" in Settings > Security | src |  |
| `main/window-security-guards.ts:58` | warn | Blocked webview with disallowed URL scheme | src |  |

## core:shutdown (3)

| Location | Level | Message | meta | tel |
|---|---|---|---|---|
| `main/index.ts:453` | error | ``Failed to ${operation}: ${error instanceof Error ? error.message : String(error)}`` |  |  |
| `main/services/app-shutdown.ts:68` | info | Shutting down: stopping agents, saving sessions, restoring configs | reason |  |
| `main/services/app-shutdown.ts:98` | error | ``Failed to ${operation}: ${error instanceof Error ? error.message : String(error)}`` |  |  |

## core:startup (3)

| Location | Level | Message | meta | tel |
|---|---|---|---|---|
| `main/index.ts:277` | info | ``Clubhouse v${app.getVersion()} starting`` | version, platform, arch, electron, node, packaged |  |
| `main/index.ts:406` | info | ``Found ${pendingState.sessions.length} sessions to resume after update`` |  |  |
| `main/index.ts:409` | error | ``Failed to load pending resumes: ${err instanceof Error ? err.message : String(err)}`` |  |  |

## core:telemetry (8)

| Location | Level | Message | meta | tel |
|---|---|---|---|---|
| `main/telemetry/bootstrap.ts:217` | warn | Could not move the Phase 1 telemetry secret to secure storage | error |  |
| `main/telemetry/bootstrap.ts:252` | warn | Telemetry destination failed to start | destination, error |  |
| `main/telemetry/bootstrap.ts:299` | `lvl` | ``OpenTelemetry: ${message}`` |  |  |
| `main/telemetry/bootstrap.ts:300` | `lvl` | `message` | `meta` |  |
| `main/telemetry/bootstrap.ts:306` | info | Telemetry export started | destinations, level, initMs |  |
| `main/telemetry/bootstrap.ts:313` | warn | Telemetry unavailable: SDK failed to start | error |  |
| `main/telemetry/bootstrap.ts:334` | warn | Secure storage is unavailable: the Phase 1 telemetry secret stays in plaintext in telemetry-settings.json unti |  |  |
| `main/telemetry/bootstrap.ts:337` | warn | Could not move the Phase 1 telemetry secret to secure storage | error |  |

## core:window (2)

| Location | Level | Message | meta | tel |
|---|---|---|---|---|
| `main/ipc/window-handlers.ts:215` | info | Pop-out window closed | windowId |  |
| `main/ipc/window-handlers.ts:218` | info | Pop-out window created | windowId, type, agentId |  |

## marketplace (12)

| Location | Level | Message | meta | tel |
|---|---|---|---|---|
| `main/services/marketplace-service.ts:71` | info | Fetching plugin registry |  |  |
| `main/services/marketplace-service.ts:88` | warn | Could not fetch featured.json |  |  |
| `main/services/marketplace-service.ts:94` | info | ``Registry loaded: ${registry.plugins.length} plugin(s)`` |  |  |
| `main/services/marketplace-service.ts:124` | info | ``Fetching custom registry: ${marketplace.name} (${marketplace.url})`` |  |  |
| `main/services/marketplace-service.ts:134` | warn | ``Custom registry "${marketplace.name}" uses version ${registry.version}, client supports ${SUPPORTED_REGISTRY |  |  |
| `main/services/marketplace-service.ts:152` | info | ``Custom registry "${marketplace.name}" loaded: ${registry.plugins.length} plugin(s)`` |  |  |
| `main/services/marketplace-service.ts:216` | warn | ``Failed to fetch custom registry "${marketplace.name}": ${error}`` |  |  |
| `main/services/marketplace-service.ts:283` | error | ``Refusing to install plugin: ${message}`` |  |  |
| `main/services/marketplace-service.ts:287` | info | ``Installing plugin: ${pluginId} from ${assetUrl}`` |  |  |
| `main/services/marketplace-service.ts:373` | error | ``Failed to restore previous install of ${pluginId} from ${backupDir}: ${restoreMsg}`` |  |  |
| `main/services/marketplace-service.ts:382` | info | ``Plugin ${pluginId} installed successfully`` |  |  |
| `main/services/marketplace-service.ts:386` | error | ``Failed to install ${pluginId}: ${message}`` |  |  |

## marketplace:custom (4)

| Location | Level | Message | meta | tel |
|---|---|---|---|---|
| `main/services/custom-marketplace-service.ts:40` | warn | Failed to read custom marketplaces |  |  |
| `main/services/custom-marketplace-service.ts:90` | info | ``Added custom marketplace: ${marketplace.name} (${marketplace.url})`` |  |  |
| `main/services/custom-marketplace-service.ts:104` | info | ``Removed custom marketplace: ${removed.name}`` |  |  |
| `main/services/custom-marketplace-service.ts:117` | info | ``${req.enabled ? 'Enabled' : 'Disabled'} custom marketplace: ${marketplace.name}`` |  |  |

## marketplace:updates (7)

| Location | Level | Message | meta | tel |
|---|---|---|---|---|
| `main/services/plugin-update-service.ts:136` | info | Checking for plugin updates |  |  |
| `main/services/plugin-update-service.ts:164` | info | ``Skipping update for ${regPlugin.id}: requires API ${release.api}, supported: ${SUPPORTED_PLUGIN_API_VERSIONS |  |  |
| `main/services/plugin-update-service.ts:191` | info | ``Plugin update check complete: ${updates.length} update(s) available, ${incompatibleUpdates.length} incompati | pluginIds, incompatibleIds, checkedAt |  |
| `main/services/plugin-update-service.ts:198` | error | ``Plugin update check failed: ${msg}`` |  |  |
| `main/services/plugin-update-service.ts:246` | info | ``Updating plugin: ${pluginId} ${updateInfo.currentVersion} -> ${updateInfo.latestVersion}`` |  |  |
| `main/services/plugin-update-service.ts:285` | info | ``Plugin ${pluginId} updated to ${updateInfo.latestVersion}`` |  |  |
| `main/services/plugin-update-service.ts:290` | error | ``Failed to update plugin ${pluginId}: ${msg}`` |  |  |

## plugin:<id> (plugin API) (4)

| Location | Level | Message | meta | tel |
|---|---|---|---|---|
| `renderer/plugins/plugin-api-files.ts:317` | error | ``Failed to start file watch: ${err.message}`` |  |  |
| `renderer/plugins/plugin-api-sounds.ts:10` | info | ``Sound pack registered: ${name \|\| ctx.pluginId}`` |  |  |
| `renderer/plugins/plugin-api-sounds.ts:13` | info | Sound pack unregistered |  |  |
| `renderer/plugins/plugin-api-workspace.ts:34` | error | ``Failed to start workspace watch: ${err.message}`` |  |  |

## store:commandPalette (1)

| Location | Level | Message | meta | tel |
|---|---|---|---|---|
| `renderer/stores/commandPaletteStore.ts:19` | warn | Corrupt command palette recents in localStorage — reset to defaults | key, error |  |

## store:onboarding (1)

| Location | Level | Message | meta | tel |
|---|---|---|---|---|
| `renderer/stores/onboardingStore.ts:20` | warn | Corrupt onboarding state in localStorage — reset to defaults | key, error |  |

## store:ui (3)

| Location | Level | Message | meta | tel |
|---|---|---|---|---|
| `renderer/stores/uiStore.ts:30` | warn | Corrupt view preferences in localStorage — reset to defaults | key, error |  |
| `renderer/stores/uiStore.ts:41` | warn | Failed to persist view prefs to localStorage (quota?) | key, error |  |
| `renderer/stores/uiStore.ts:132` | warn | Failed to persist active host to localStorage (quota?) | key, error |  |

## telemetry:control (1)

| Location | Level | Message | meta | tel |
|---|---|---|---|---|
| `main/telemetry/control.ts:523` | warn | Could not update the Clubhouse developer destination | error |  |

## ui:chat:switch (3)

| Location | Level | Message | meta | tel |
|---|---|---|---|---|
| `renderer/features/agents/chat/AgentRuntimePane.tsx:165` | info | Runtime switch requested | ......meta, breadcrumb |  |
| `renderer/features/agents/chat/AgentRuntimePane.tsx:178` | info | Runtime switch: respawning | ......meta, resumeSessionId |  |
| `renderer/features/agents/chat/AgentRuntimePane.tsx:181` | error | Runtime switch failed | ......meta, error, breadcrumb |  |

## ui:nav (1)

| Location | Level | Message | meta | tel |
|---|---|---|---|---|
| `renderer/chrome/telemetry.ts:29` | debug | View changed | view, breadcrumb |  |

## ui:perf (2)

| Location | Level | Message | meta | tel |
|---|---|---|---|---|
| `main/telemetry/crash-handlers.ts:39` | warn | Window unresponsive | windowKind |  |
| `main/telemetry/crash-handlers.ts:47` | warn | Window responsive again | windowKind, durationMs |  |

## ui:terminal:scroll (12)

| Location | Level | Message | meta | tel |
|---|---|---|---|---|
| `renderer/features/agents/AgentTerminal.tsx:179` | debug | Terminal initialized | agentId, isRemote, cols, rows |  |
| `renderer/features/agents/AgentTerminal.tsx:191` | debug | Buffer replay (local) | agentId, bufLen, seq |  |
| `renderer/features/agents/AgentTerminal.tsx:209` | error | Buffer replay failed (local) | agentId, error |  |
| `renderer/features/agents/AgentTerminal.tsx:221` | debug | Buffer replay (remote/annex) | agentId, satelliteId, bufLen |  |
| `renderer/features/agents/AgentTerminal.tsx:231` | error | Buffer replay failed (remote/annex) | agentId, satelliteId, error |  |
| `renderer/features/agents/AgentTerminal.tsx:288` | debug | ``PTY data write (${source})`` | agentId, dataLen, writeCount, viewportY, baseY, scrollPct, atBottom |  |
| `renderer/features/agents/AgentTerminal.tsx:345` | info | PTY exited, resetting terminal state | agentId, isRemote |  |
| `renderer/features/agents/AgentTerminal.tsx:415` | debug | Scroll state | ......logMeta, viewportY, baseY, scrollPct, atBottom, lastKnown |  |
| `renderer/features/agents/AgentTerminal.tsx:421` | info | Viewport jumped to top | ......logMeta, viewportY, baseY, lastKnown |  |
| `renderer/features/terminal/useTerminalFit.ts:39` | debug | Viewport re-pinned to bottom after fit | sessionId, savedViewportY, baseY |  |
| `renderer/features/terminal/useTerminalFit.ts:85` | debug | fitAndResize | sessionId, trigger, sendResize, viewportY, atBottom, containerWidth, containerHeight |  |
| `renderer/features/terminal/useTerminalFit.ts:144` | debug | fitAndResize | sessionId, trigger, sendResize, viewportY, atBottom |  |

## update:apply (1)

| Location | Level | Message | meta | tel |
|---|---|---|---|---|
| `main/services/auto-update-service.ts:1033` | error | ``Failed to apply update: ${msg}`` |  |  |

## update:apply / update:apply-on-quit (3)

| Location | Level | Message | meta | tel |
|---|---|---|---|---|
| `main/services/auto-update-service.ts:826` | info | `logScope === 'update:apply' ? 'Applying update' : 'Applying update on quit (silent)'` | version, downloadPath |  |
| `main/services/auto-update-service.ts:938` | info | Linux: .rpm installed successfully | downloadPath |  |
| `main/services/auto-update-service.ts:953` | info | Linux: .deb installed successfully | downloadPath |  |

## update:apply-detect (1)

| Location | Level | Message | meta | tel |
|---|---|---|---|---|
| `main/services/auto-update-service.ts:1346` | warn | Previous update apply attempt did not succeed | attemptedVersion, currentVersion, attemptedAt |  |

## update:apply-on-quit (2)

| Location | Level | Message | meta | tel |
|---|---|---|---|---|
| `main/services/auto-update-service.ts:926` | error | ``Updater failed to start: ${spawnErr.message}`` |  |  |
| `main/services/auto-update-service.ts:1078` | warn | ``Failed to apply update on quit: ${err instanceof Error ? err.message : String(err)}`` |  |  |

## update:check (13)

| Location | Level | Message | meta | tel |
|---|---|---|---|---|
| `main/services/auto-update-service.ts:554` | warn | Stable manifest fetch failed | url, error |  |
| `main/services/auto-update-service.ts:560` | warn | Preview manifest fetch failed | url, error |  |
| `main/services/auto-update-service.ts:599` | info | Checking for updates | manual, currentVersion, previewChannel |  |
| `main/services/auto-update-service.ts:610` | info | Fetched manifest | sourceUrl, manifestVersion |  |
| `main/services/auto-update-service.ts:620` | warn | Saving the chat CLI denylist failed | error |  |
| `main/services/auto-update-service.ts:627` | info | App is up to date | currentVersion, latestVersion |  |
| `main/services/auto-update-service.ts:638` | info | Update dismissed by user | version |  |
| `main/services/auto-update-service.ts:650` | warn | ``No artifact for platform ${key}`` | version, availableKeys |  |
| `main/services/auto-update-service.ts:658` | info | ``Update available: ${manifest.version}`` | currentVersion, newVersion |  |
| `main/services/auto-update-service.ts:668` | info | Windows: Squirrel native update ready | releasesUrl |  |
| `main/services/auto-update-service.ts:691` | error | ``Update check failed: ${msg}`` |  |  |
| `main/services/auto-update-service.ts:1403` | error | ``Startup update check failed: ${err instanceof Error ? err.message : String(err)}`` |  |  |
| `main/services/auto-update-service.ts:1412` | error | ``Periodic update check failed: ${err instanceof Error ? err.message : String(err)}`` |  |  |

## update:download (4)

| Location | Level | Message | meta | tel |
|---|---|---|---|---|
| `main/services/auto-update-service.ts:722` | info | Update already downloaded and verified |  |  |
| `main/services/auto-update-service.ts:768` | info | Download complete, verifying checksum |  |  |
| `main/services/auto-update-service.ts:776` | info | Update verified and ready to install |  |  |
| `main/services/auto-update-service.ts:787` | error | ``Download failed: ${msg}`` |  |  |

## update:fetch (1)

| Location | Level | Message | meta | tel |
|---|---|---|---|---|
| `main/services/auto-update-service.ts:394` | error | `err.message` |  |  |

## update:history (3)

| Location | Level | Message | meta | tel |
|---|---|---|---|---|
| `main/services/auto-update-service.ts:1271` | info | Fetching version history | currentVersion, historyUrl |  |
| `main/services/auto-update-service.ts:1276` | warn | Invalid history.json format |  |  |
| `main/services/auto-update-service.ts:1284` | error | ``Failed to fetch version history: ${msg}`` |  |  |

## update:restore (1)

| Location | Level | Message | meta | tel |
|---|---|---|---|---|
| `main/services/auto-update-service.ts:1370` | info | Restoring pending update from previous session | version |  |

## update:retry (1)

| Location | Level | Message | meta | tel |
|---|---|---|---|---|
| `main/services/auto-update-service.ts:70` | info | ``${label} attempt ${attempt + 1}/${retries + 1} failed, retrying in ${Math.round(delay / 1000)}s`` | error |  |

## update:session-resume (7)

| Location | Level | Message | meta | tel |
|---|---|---|---|---|
| `main/services/restart-session-service.ts:68` | warn | Session lookup failed; will resume the most recent session | agentId, cwd, error |  |
| `main/services/restart-session-service.ts:121` | info | ``Captured ${sessions.length} sessions for resume`` | sessionCount, agentIds |  |
| `main/services/restart-session-service.ts:140` | warn | Corrupt restart-session-state.json, deleting |  |  |
| `main/services/restart-session-service.ts:146` | info | ``Schema version mismatch (got ${state.version}, want ${SCHEMA_VERSION}), discarding`` |  |  |
| `main/services/restart-session-service.ts:153` | info | ``Restart state too old (${Math.round(age / 3600000)}h), discarding`` |  |  |
| `main/services/restart-session-service.ts:166` | warn | ``Skipping resume for ${session.agentId} — directory missing: ${session.worktreePath \|\| session.projectPath} |  |  |
| `main/services/restart-session-service.ts:171` | info | ``Loaded ${state.sessions.length} pending resumes`` |  |  |

## `ns` (5)

| Location | Level | Message | meta | tel |
|---|---|---|---|---|
| `renderer/plugins/plugin-api-logging.ts:8` | debug | `msg` | `meta` |  |
| `renderer/plugins/plugin-api-logging.ts:11` | info | `msg` | `meta` |  |
| `renderer/plugins/plugin-api-logging.ts:14` | warn | `msg` | `meta` |  |
| `renderer/plugins/plugin-api-logging.ts:17` | error | `msg` | `meta` |  |
| `renderer/plugins/plugin-api-logging.ts:20` | fatal | `msg` | `meta` |  |

