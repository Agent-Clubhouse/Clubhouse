import { actionDetailsNames } from './actions/details-names';
import type { RemoteDetailsCard } from '../../shared/remote-agent-details';
import { readPassiveConnectionCard, type ConnectionCardReadOptions } from './remote-connection-card';
import { readActionDetailsForAgent, peekActionProjectName } from './actions';
import { getAgentCanvasMemberships } from './canvas-store-reader';
import { row } from './remote-details-presentation';

export const readConnectionCard = (c: RemoteDetailsCard, wiresId: string, options: ConnectionCardReadOptions) => readPassiveConnectionCard(c, wiresId, options);

export function readActionCard(c: RemoteDetailsCard, agentId: string, projectId: string, dispatcher = false, selectedNames?: { agentName?: string; projectName?: string }) {
  const resolver = actionDetailsNames(peekActionProjectName, { agentId, projectId, ...selectedNames });
  const fields = readActionDetailsForAgent(agentId, projectId, dispatcher, resolver.names);
  c.summary = fields.summary; c.rows = fields.rows; c.notes.push(...fields.notes, ...resolver.notices()); c.omitted += fields.omitted;
}

export async function readCanvasCard(c: RemoteDetailsCard, agentId: string, projectId: string) {
  const hits = await getAgentCanvasMemberships(agentId, projectId, { strict: true });
  c.summary = `on ${hits.length} ${hits.length === 1 ? 'board' : 'boards'}`;
  for (const hit of hits) {
    const before = c.rows.length;
    row(c, hit.name, hit.scope === 'app' ? 'Home' : 'card');
    if (c.rows.length > before && hit.canvasId && hit.viewId && hit.canvasId.length <= 2048 && hit.viewId.length <= 2048) {
      c.rows[c.rows.length - 1].canvas = { scope: hit.scope, canvasId: hit.canvasId, viewId: hit.viewId };
    }
  }
  if (!hits.length) c.state = 'not-applicable';
}
