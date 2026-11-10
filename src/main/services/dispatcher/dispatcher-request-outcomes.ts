/**
 * Wires the user's requests (dispatcher-requests) to the running Dispatcher
 * (#3237): the coordinator's chat events say when a request's turn failed or
 * was stopped, and a request that ends with no answer is told to the chat,
 * so the user hears every outcome. The agents it reaches are noted in
 * agent-tools.
 */
import { onChatEvent } from '../agent-runtime/chat-event-bus';
import { appLog } from '../log-service';
import { CHAT_UPDATE_TAG, deliverUpdateToChat, type ChannelMessage } from './dispatcher-channel';
import {
  doneList,
  noteWorkEvent,
  setRequestEndedHandler,
  type DispatcherRequest,
  type RequestEnding,
} from './dispatcher-requests';
import { isDispatcherAgentId } from './dispatcher-service';

const NS = 'core:dispatcher';

/** What the chat is told when a request ends with no answer. */
export function requestEndedMessage(request: Pick<DispatcherRequest, 'id' | 'done'>, ending: RequestEnding, detail?: string): ChannelMessage {
  const { id } = request;
  // Part of it may be done (#3241): the user hears that, and a retry carries on from there.
  const done = doneList(request);
  const retry = `Tell the user in a few words that it didn't get done, and offer to try again. To try again, call start_work with request_id ${id}.`;
  let what: string;
  let shown: string;
  switch (ending) {
    case 'failed':
      what = `Request ${id} stopped with an error${detail ? `: ${detail}` : ''}. ${retry}`;
      shown = 'The request stopped with an error.';
      break;
    case 'cancelled':
      what = `Request ${id} was stopped before it finished. ${retry}`;
      shown = 'The request was stopped before it finished.';
      break;
    case 'timed_out':
      what = `Request ${id} has had no outcome for a while. `
        + 'Tell the user in a few words that you don\'t have the outcome yet, and offer to check on it or try again. '
        + `To do either, call start_work with request_id ${id}.`;
      shown = 'The request has no outcome yet.';
      break;
  }
  const partly = done ? `\n\nThese parts are done, and a retry won't repeat them:\n${done}` : '';
  return { text: `${CHAT_UPDATE_TAG} ${what}${partly}`, routed: [{ fromClubhouse: true, text: shown }] };
}

function tellChat(request: DispatcherRequest, ending: RequestEnding, detail?: string): void {
  void deliverUpdateToChat(requestEndedMessage(request, ending, detail)).then((result) => {
    if (result.outcome !== 'delivered' && result.outcome !== 'started') {
      appLog(NS, 'warn', 'A request\'s outcome did not reach the chat', { meta: { request: request.id, ending, outcome: result.outcome } });
    }
  }, (err: unknown) => {
    // telemetry-exempt: logged; the request is ended and stays so
    appLog(NS, 'warn', 'A request\'s outcome did not reach the chat', { meta: { request: request.id, ending, error: err instanceof Error ? err.message : String(err) } });
  });
}

let stop: (() => void) | null = null;

/** Start following the Dispatcher's turns and telling the chat how requests end. Returns a stop function. */
export function installRequestTracking(): () => void {
  stop?.();
  setRequestEndedHandler(tellChat);
  const unsubscribe = onChatEvent((event) => {
    if (isDispatcherAgentId(event.agentId)) noteWorkEvent(event);
  });
  stop = () => {
    unsubscribe();
    // Also stops the timeout timer.
    setRequestEndedHandler(null);
    stop = null;
  };
  return stop;
}
