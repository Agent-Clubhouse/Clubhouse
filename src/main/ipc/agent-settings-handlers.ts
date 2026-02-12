import { ipcMain } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { IPC } from '../../shared/ipc-channels';
import { DurableAgentConfig } from '../../shared/types';
import * as agentSettings from '../services/agent-settings-service';

export function registerAgentSettingsHandlers(): void {
  ipcMain.handle(IPC.AGENT.READ_CLAUDE_MD, (_event, worktreePath: string) => {
    return agentSettings.readClaudeMd(worktreePath);
  });

  ipcMain.handle(IPC.AGENT.SAVE_CLAUDE_MD, (_event, worktreePath: string, content: string, projectPath?: string, agentId?: string) => {
    agentSettings.writeClaudeMd(worktreePath, content);

    // Auto-set override to true when user saves custom CLAUDE.md
    if (projectPath && agentId) {
      try {
        const agentsPath = path.join(projectPath, '.clubhouse', 'agents.json');
        if (fs.existsSync(agentsPath)) {
          const agents: DurableAgentConfig[] = JSON.parse(fs.readFileSync(agentsPath, 'utf-8'));
          const agent = agents.find((a) => a.id === agentId);
          if (agent && agent.overrides && !agent.overrides.claudeMd) {
            agent.overrides.claudeMd = true;
            fs.writeFileSync(agentsPath, JSON.stringify(agents, null, 2), 'utf-8');
          }
        }
      } catch {
        // Non-critical: override flag not set
      }
    }
  });

  ipcMain.handle(IPC.AGENT.READ_MCP_CONFIG, (_event, worktreePath: string) => {
    return agentSettings.readMcpConfig(worktreePath);
  });

  ipcMain.handle(IPC.AGENT.LIST_SKILLS, (_event, worktreePath: string) => {
    return agentSettings.listSkills(worktreePath);
  });
}
