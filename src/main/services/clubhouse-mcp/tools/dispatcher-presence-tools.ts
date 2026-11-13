/**
 * The controller's read-only view of its peers on other computers (#3349):
 * the same snapshot Settings › Dispatcher shows. It changes nothing and
 * contacts no computer; it reads what the controller links already know.
 */
import { registerGlobalTool } from '../tool-registry';
import { getDispatcherPresence } from '../../dispatcher-presence';

export function registerDispatcherPresenceTools(): void {
  registerGlobalTool(
    'list_other_dispatchers',
    {
      description:
        'List the Dispatchers on the person\'s other computers: each one\'s label ("<name> on <machine>"), state (online, working, asleep, ' +
        'offline with last seen, off, or not known yet) and the state of your link to it, with the reason when it is paused or unavailable. ' +
        'Read-only. Name them by their label, never by id. Use the address only as a send target.',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    async () => ({ content: [{ type: 'text', text: JSON.stringify(getDispatcherPresence()) }] }),
    { group: 'dispatcher', grant: { actions: ['agent.read'], target: 'connected' } },
  );
}
