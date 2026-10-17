import React from 'react';
import { rendererLog } from '../plugins/renderer-logger';
import { ATTR, surfaceAttrs, tel } from '../telemetry';

interface Props {
  children: React.ReactNode;
}

interface State {
  hasError: boolean;
}

/**
 * Last-resort boundary around the whole app (spec §4.2). Before this existed a
 * render error anywhere outside a plugin unmounted the tree and left a blank
 * window. It logs locally, reports the error class and stack to telemetry
 * (never the message), and offers a reload.
 */
export class AppErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    rendererLog('core:renderer', 'error', 'App render error', {
      meta: { error: error.message, stack: error.stack, componentStack: info.componentStack },
    });
    tel.exception(error, { handled: true, attrs: [ATTR.errorBoundary('app'), ...surfaceAttrs()] });
  }

  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <div className="flex items-center justify-center h-screen bg-ctp-base text-ctp-text">
        <div className="text-center max-w-md flex flex-col gap-3 items-center">
          <p className="text-lg">Something went wrong</p>
          <p className="text-sm text-ctp-subtext0">
            Clubhouse hit an unexpected error while drawing this window. Your agents and files are unaffected.
          </p>
          <button
            type="button"
            className="px-3 py-1.5 rounded bg-ctp-surface0 hover:bg-ctp-surface1 text-sm"
            onClick={() => window.location.reload()}
          >
            Reload window
          </button>
        </div>
      </div>
    );
  }
}
