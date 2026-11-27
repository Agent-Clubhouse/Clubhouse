import { Button } from '../../../components/Button';
import { openAppSettings } from '../tour-actions';
import type { SceneDef } from './types';

/** Managed agents (#2819, docs/managed-agents.md). Upgraders see `switched` first. */

function SwitchedExtra() {
  return (
    <div className="wt-x">
      <Button onClick={() => openAppSettings('managed-switch')}>Open Switch agents</Button>
      <span className="wt-muted">For agents that weren&rsquo;t using either</span>
    </div>
  );
}

export const switched: SceneDef = {
  title: 'Your agents switched to parts',
  text: 'Personas and Clubhouse Mode are gone. Each agent that used them switched at its next start and kept what it had. Its earlier files are kept, and its Setup says where. Nothing switches while this tour is open.',
  Extra: SwitchedExtra,
};

export const compose: SceneDef = {
  title: 'Instructions are blocks, joined in order',
  text: 'Pick the instruction blocks an agent reads, in the order it reads them. At every start, Clubhouse joins them into the file its CLI reads, then fills in the agent’s name, workspace and branch. It adds no text of its own.',
};

export const skills: SceneDef = {
  title: 'Skills and MCP servers come along the same way',
  text: 'Add skills and MCP servers from the library like blocks. Each start copies skills into the agent’s skills folder and writes its MCP servers where the CLI looks. The Clubhouse server is always on.',
};

export const updates: SceneDef = {
  title: 'Edit a part once and every agent gets it',
  text: 'Before you save, Clubhouse shows which agents and templates use the part. Each agent picks up the change at its next start. A running one offers Restart, which keeps the conversation. Built-in parts update the same way when Clubhouse updates.',
};

export const share: SceneDef = {
  title: 'Agents share what they have in common',
  text: 'reviewer and api-builder share five parts and keep their own roles. One edit to a shared part reaches both. To change it for one agent only, fork it for that agent. The other keeps the original, and Back to shared undoes the fork.',
};
