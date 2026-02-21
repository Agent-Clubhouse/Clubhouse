import * as React from 'react';
import * as ReactDOM from 'react-dom';
import * as jsxRuntime from 'react/jsx-runtime';
import { createRoot } from 'react-dom/client';
import { createElement } from 'react';
import { App } from './App';
import { PopoutWindow } from './features/popout/PopoutWindow';
import './index.css';

// Expose React on globalThis so community plugins loaded via native ESM
// dynamic import can access React without going through webpack's module system.
// The import map in index.html references these globals via data URI shims.
(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).ReactDOM = ReactDOM;
(globalThis as Record<string, unknown>).__REACT_JSX_RUNTIME__ = jsxRuntime;

const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  const isPopout = window.clubhouse.window?.isPopout();
  root.render(createElement(isPopout ? PopoutWindow : App));
}
