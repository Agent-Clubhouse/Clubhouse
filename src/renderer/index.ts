import * as React from 'react';
import * as ReactDOM from 'react-dom';
import * as jsxRuntime from 'react/jsx-runtime';
import * as ReactDOMClient from 'react-dom/client';
import { createElement } from 'react';
import { App } from './App';
import { PopoutWindow } from './features/popout/PopoutWindow';
import { AppErrorBoundary } from './components/AppErrorBoundary';
import { initRendererTelemetry, installRendererErrorHandlers, startLongFrameCollection, startUiPerf } from './telemetry';
import './index.css';

// Expose React on globalThis so community plugins loaded via native ESM
// dynamic import can access React without going through webpack's module system.
// The import map in index.html references these globals via data URI shims.
(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).ReactDOM = ReactDOM;
(globalThis as Record<string, unknown>).ReactDOMClient = ReactDOMClient;
(globalThis as Record<string, unknown>).__REACT_JSX_RUNTIME__ = jsxRuntime;

// Telemetry is off unless main says otherwise; these are inert until then.
initRendererTelemetry();
installRendererErrorHandlers();
startLongFrameCollection();
// The local hang and lag log (#2126) runs whether or not telemetry is on.
startUiPerf();

const container = document.getElementById('root');
if (container) {
  const root = ReactDOMClient.createRoot(container);
  const isPopout = window.clubhouse.window?.isPopout();
  root.render(createElement(AppErrorBoundary, null, createElement(isPopout ? PopoutWindow : App)));
}
