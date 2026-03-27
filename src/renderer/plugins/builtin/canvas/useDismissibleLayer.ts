import { useEffect, useRef } from 'react';
import type React from 'react';

interface UseDismissibleLayerOptions {
  layerRef: React.RefObject<HTMLElement | null>;
  onDismiss: () => void;
  enabled?: boolean;
  closeOnEscape?: boolean;
  closeOnFocusOutside?: boolean;
  closeOnWindowBlur?: boolean;
}

export function useDismissibleLayer({
  layerRef,
  onDismiss,
  enabled = true,
  closeOnEscape = true,
  closeOnFocusOutside = true,
  closeOnWindowBlur = true,
}: UseDismissibleLayerOptions) {
  const onDismissRef = useRef(onDismiss);

  useEffect(() => {
    onDismissRef.current = onDismiss;
  }, [onDismiss]);

  useEffect(() => {
    if (!enabled) return;

    const isInsideLayer = (target: EventTarget | null) => {
      if (!layerRef.current || !(target instanceof Node)) {
        return false;
      }
      return layerRef.current.contains(target);
    };

    const handleMouseDown = (event: MouseEvent) => {
      if (!isInsideLayer(event.target)) {
        onDismissRef.current();
      }
    };

    const handleFocusIn = (event: FocusEvent) => {
      if (!closeOnFocusOutside || isInsideLayer(event.target)) {
        return;
      }
      onDismissRef.current();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (closeOnEscape && event.key === 'Escape') {
        onDismissRef.current();
      }
    };

    const handleWindowBlur = () => {
      if (closeOnWindowBlur) {
        onDismissRef.current();
      }
    };

    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('focusin', handleFocusIn);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('blur', handleWindowBlur);

    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('focusin', handleFocusIn);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('blur', handleWindowBlur);
    };
  }, [closeOnEscape, closeOnFocusOutside, closeOnWindowBlur, enabled, layerRef]);
}
