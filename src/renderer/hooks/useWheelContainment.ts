import { useCallback } from 'react';
import type { WheelEvent as ReactWheelEvent } from 'react';

export type WheelContainmentEvent = Pick<ReactWheelEvent, 'ctrlKey' | 'metaKey' | 'stopPropagation'>;

export function shouldContainWheelEvent(event: Pick<ReactWheelEvent, 'ctrlKey' | 'metaKey'>): boolean {
  return !event.ctrlKey && !event.metaKey;
}

export function stopPlainWheelPropagation(event: WheelContainmentEvent): void {
  if (!shouldContainWheelEvent(event)) return;
  event.stopPropagation();
}

export function useWheelContainment() {
  return useCallback((event: WheelContainmentEvent) => {
    if (!shouldContainWheelEvent(event)) return;
    event.stopPropagation();
  }, []);
}
