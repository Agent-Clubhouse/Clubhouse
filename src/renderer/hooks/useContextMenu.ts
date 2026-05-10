import { useState, useCallback } from 'react';

interface Position { x: number; y: number }

interface Return {
  open: boolean;
  position: Position;
  onContextMenu: (e: React.MouseEvent) => void;
  close: () => void;
}

export function useContextMenu(): Return {
  const [state, setState] = useState<{ open: boolean; position: Position }>({
    open: false,
    position: { x: 0, y: 0 },
  });

  const onContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setState({ open: true, position: { x: e.clientX, y: e.clientY } });
  }, []);

  const close = useCallback(() => setState((s) => ({ ...s, open: false })), []);

  return { open: state.open, position: state.position, onContextMenu, close };
}
