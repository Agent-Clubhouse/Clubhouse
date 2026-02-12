import * as fs from 'fs';
import * as path from 'path';
import { waitReady } from './hook-server';

export async function writeHooksConfig(worktreePath: string, agentId: string, options?: { allowedTools?: string[] }): Promise<void> {
  const port = await waitReady();

  const curlBase = `cat | curl -s -X POST http://127.0.0.1:${port}/hook/${agentId} -H 'Content-Type: application/json' --data-binary @- || true`;

  const settings = {
    hooks: {
      PreToolUse: [
        {
          hooks: [
            {
              type: 'command',
              command: curlBase,
              async: true,
              timeout: 5,
            },
          ],
        },
      ],
      PostToolUse: [
        {
          hooks: [
            {
              type: 'command',
              command: curlBase,
              async: true,
              timeout: 5,
            },
          ],
        },
      ],
      PostToolUseFailure: [
        {
          hooks: [
            {
              type: 'command',
              command: curlBase,
              async: true,
              timeout: 5,
            },
          ],
        },
      ],
      Stop: [
        {
          hooks: [
            {
              type: 'command',
              command: curlBase,
              async: true,
              timeout: 5,
            },
          ],
        },
      ],
      Notification: [
        {
          matcher: 'permission_prompt',
          hooks: [
            {
              type: 'command',
              command: curlBase,
              async: true,
              timeout: 5,
            },
          ],
        },
      ],
    },
  };

  const claudeDir = path.join(worktreePath, '.claude');
  if (!fs.existsSync(claudeDir)) {
    fs.mkdirSync(claudeDir, { recursive: true });
  }

  // Write to settings.local.json (gitignored) to avoid polluting the repo
  const settingsPath = path.join(claudeDir, 'settings.local.json');

  // Merge with existing settings if present, preserving permissions key
  // (coexistence contract: materializer owns 'permissions', hooks owns 'hooks')
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  } catch {
    // No existing file
  }

  const merged: Record<string, unknown> = { ...existing, hooks: settings.hooks };
  if (options?.allowedTools && options.allowedTools.length > 0) {
    merged.allowedTools = options.allowedTools;
  }
  fs.writeFileSync(settingsPath, JSON.stringify(merged, null, 2), 'utf-8');
  console.log(`Wrote hooks config for agent ${agentId} at ${settingsPath} (port ${port})`);
}
