/**
 * Appearance tools (#2597): update_project and update_agent, for every agent.
 * The rules live in appearance-service, shared with the CLI (#2598); these
 * only say who is asking and turn arguments and refusals into tool results.
 */

import { registerGlobalTool } from '../tool-registry';
import type { McpToolResult } from '../types';
import { isDispatcherAgent } from '../dispatcher-gate';
import { agentRegistry, getAgentCwd } from '../../agent-registry';
import { AppearanceError, updateAgentAppearance, updateProjectAppearance, type AppearanceActor } from '../../appearance-service';
import { appLog } from '../../log-service';
import { McpArgError, optionalString } from './validation';
import { AGENT_COLORS } from '../../../../shared/name-generator';

function jsonResult(value: unknown): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function errorResult(text: string): McpToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

function actorFor(agentId: string): AppearanceActor {
  const cwd = getAgentCwd(agentId) ?? agentRegistry.get(agentId)?.projectPath;
  if (isDispatcherAgent(agentId)) return { scope: 'all', agentId, cwd };
  const projectPath = agentRegistry.get(agentId)?.projectPath;
  if (!projectPath) throw new AppearanceError('not_found', 'Clubhouse doesn\'t know this agent.');
  return { scope: 'own', agentId, projectPath, cwd };
}

/** Refuse a setting these tools don't change, rather than ignore it and report success. */
function assertOnly(args: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(args).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new McpArgError(`This tool can't change ${unknown.join(', ')}. It takes only: ${allowed.join(', ')}.`);
}

async function guarded(tool: string, agentId: string, run: () => Promise<unknown>): Promise<McpToolResult> {
  try {
    return jsonResult(await run());
  } catch (err) {
    if (err instanceof AppearanceError || err instanceof McpArgError) return errorResult(err.message);
    const message = err instanceof Error ? err.message : String(err);
    // telemetry-exempt: logged; the error reaches the agent as the tool result
    appLog('core:mcp', 'warn', `${tool} failed`, { meta: { agentId, error: message } });
    return errorResult(message);
  }
}

const COLOR_IDS = AGENT_COLORS.map((c) => c.id);
const IMAGE_DESCRIPTION =
  'Path of an image file: PNG, JPEG, GIF, WebP or SVG, up to 20 MB. Large images are resized. Relative paths start from your working directory. ' +
  'Replaces the emoji. Empty removes the image.';
const EMOJI_DESCRIPTION = 'A single emoji. Replaces the image. Empty removes the emoji.';

const PROJECT_FIELDS = ['project', 'display_name', 'color', 'emoji', 'image_path'] as const;
const AGENT_FIELDS = ['agent_id', 'color', 'emoji', 'image_path'] as const;

export function registerAppearanceTools(): void {
  registerGlobalTool(
    'update_project',
    {
      description:
        'Change how a Clubhouse project looks: display name, color, emoji or image. Set only what should change. ' +
        'It updates in the app at once. You can change your own project; the Dispatcher can change any project.',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'Project name, path or id. Defaults to your own project.' },
          display_name: { type: 'string', description: 'The name to show. Empty goes back to the folder name.' },
          color: { type: 'string', enum: [...COLOR_IDS, ''], description: 'The project color. Empty removes it.' },
          emoji: { type: 'string', description: EMOJI_DESCRIPTION },
          image_path: { type: 'string', description: IMAGE_DESCRIPTION },
        },
      },
    },
    (agentId, args) => guarded('update_project', agentId, async () => {
      assertOnly(args, PROJECT_FIELDS);
      const project = await updateProjectAppearance(actorFor(agentId), optionalString(args, 'project'), {
        displayName: optionalString(args, 'display_name'),
        color: optionalString(args, 'color'),
        emoji: optionalString(args, 'emoji'),
        imagePath: optionalString(args, 'image_path'),
      });
      return { project };
    }),
  );

  registerGlobalTool(
    'update_agent',
    {
      description:
        'Change how an agent looks: color, emoji or image, at any time. Set only what should change. It updates in ' +
        'the app at once. You can change yourself; the Dispatcher can change itself and any other agent. Agents can\'t be renamed here.',
      inputSchema: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: 'The agent\'s id. Defaults to you.' },
          color: { type: 'string', enum: [...COLOR_IDS], description: 'The agent color.' },
          emoji: { type: 'string', description: EMOJI_DESCRIPTION },
          image_path: { type: 'string', description: IMAGE_DESCRIPTION },
        },
      },
    },
    (agentId, args) => guarded('update_agent', agentId, async () => {
      assertOnly(args, AGENT_FIELDS);
      const agent = await updateAgentAppearance(actorFor(agentId), optionalString(args, 'agent_id'), {
        color: optionalString(args, 'color'),
        emoji: optionalString(args, 'emoji'),
        imagePath: optionalString(args, 'image_path'),
      });
      return { agent };
    }),
  );
}
