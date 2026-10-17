/**
 * Main-process bus for stamped chat events. The chat runtime publishes; the
 * renderer bridge, Annex, the status bridge and (later) telemetry subscribe.
 * Chat owns this bus and imports nothing from its consumers.
 */

import type { ChatEvent } from '../../../shared/chat';

export type ChatEventListener = (event: ChatEvent) => void;

const listeners = new Set<ChatEventListener>();

export function publishChatEvent(event: ChatEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // A failing consumer must not break the runtime or other consumers.
    }
  }
}

export function onChatEvent(listener: ChatEventListener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** For tests. */
export function removeAllChatEventListeners(): void {
  listeners.clear();
}
