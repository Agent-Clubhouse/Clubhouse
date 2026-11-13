import { useEffect, useId, useRef, useState } from 'react';
import { Modal } from '../../../components/Modal';
import type { McpBindingEntry } from '../../../stores/mcpBindingStore';
import { usePluginStore } from '../../../plugins/plugin-store';
import {
  beginConnectionNavigationRequest, jumpToConnectionCanvas, lookupConnectionCanvases, openConnectionAgent, openConnectionPlugin,
  pluginNavigationReason, type ConnectionCanvasHit,
} from './connection-target-navigation';

type State = { kind: 'idle' | 'loading' } | { kind: 'error'; message: string } | { kind: 'choose'; hits: ConnectionCanvasHit[] };

export function ConnectionOpenAction({ targetId, targetKind, name, projectId }: {
  targetId: string; targetKind: McpBindingEntry['targetKind'] | 'plugin'; name: string; projectId: string;
}) {
  const [state, setState] = useState<State>({ kind: 'idle' });
  const request = useRef<AbortController | null>(null);
  const descriptionId = useId();
  const unsupported = usePluginStore((plugins) => targetKind === 'plugin' ? pluginNavigationReason(targetId, projectId, plugins) : null);
  useEffect(() => {
    setState({ kind: 'idle' });
    return () => { request.current?.abort(); };
  }, [targetId, targetKind, projectId]);
  const close = () => {
    request.current?.abort();
    setState({ kind: 'idle' });
  };
  const open = async (choice?: ConnectionCanvasHit) => {
    request.current?.abort();
    const controller = beginConnectionNavigationRequest();
    request.current = controller;
    controller.signal.addEventListener('abort', () => {
      if (request.current === controller) setState({ kind: 'idle' });
    }, { once: true });
    setState({ kind: 'loading' });
    try {
      if (targetKind === 'agent') {
        await openConnectionAgent(targetId, controller.signal);
      } else if (targetKind === 'plugin') {
        openConnectionPlugin(targetId, projectId);
      } else {
        const { hits, index } = await lookupConnectionCanvases(targetKind, targetId, controller.signal);
        if (!hits.length) {
          throw new Error(targetKind === 'group-project'
            ? 'No owning Canvas is available for this group project. Add its representation to a Canvas explicitly, then retry Open.'
            : 'No Canvas containing this target is available. This widget has no standalone navigation route; restore its Canvas and retry Open.');
        }
        if (!choice && hits.length > 1) {
          setState({ kind: 'choose', hits });
          return;
        }
        await jumpToConnectionCanvas(targetKind, targetId, choice ?? hits[0], controller.signal, index);
      }
      if (!controller.signal.aborted) setState({ kind: 'idle' });
    } catch (error) {
      // telemetry-exempt: the exact failure is shown with Retry Open; aborted requests are deliberately superseded.
      if (!controller.signal.aborted) {
        setState({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
      }
    }
  };

  return (
    <>
      <button type="button" disabled={!!unsupported || state.kind === 'loading'} onClick={() => { void open(); }}
        aria-describedby={descriptionId} aria-busy={state.kind === 'loading'}
        title={unsupported ?? `Open ${name}`}
        className="text-xs text-ctp-accent hover:underline cursor-pointer disabled:text-ctp-overlay1 disabled:no-underline disabled:cursor-not-allowed"
        data-testid="connection-open">
        Open
      </button>
      <span id={descriptionId} className="sr-only">{unsupported ?? `Open target ${name} (${targetId}), without editing or removing the connection.`}</span>
      <Modal open={state.kind === 'choose' || state.kind === 'error'} onClose={close}
        title={`Open ${name}`} width="w-[520px]" testId="connection-open-dialog">
        {state.kind === 'error' && (
          <div className="flex flex-col gap-3 text-xs">
            <p role="alert">{state.message}</p>
            <button type="button" onClick={() => { void open(); }} className="self-end text-ctp-accent hover:underline">Retry Open</button>
          </div>
        )}
        {state.kind === 'choose' && (
          <div className="flex flex-col gap-2 text-xs">
            <p>Choose the Canvas representation to reveal. No connections or memberships will change.</p>
            {state.hits.map((hit) => (
              <button type="button" key={`${hit.scope}:${hit.projectId ?? ''}:${hit.canvasId}:${hit.viewId}`}
                onClick={() => { void open(hit); }} className="rounded p-2 text-left hover:bg-surface-1">
                {hit.scope === 'app' ? 'Home' : `Project: ${hit.projectName ?? hit.projectId} (${hit.projectId})`}
                {' / '}Canvas: {hit.name} ({hit.canvasId}){' / '}Node: {hit.nodeName} ({hit.viewId})
              </button>
            ))}
          </div>
        )}
      </Modal>
    </>
  );
}
