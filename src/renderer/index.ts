import { createRoot } from 'react-dom/client';
import { createElement } from 'react';
import { App } from './App';
import './index.css';

const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(createElement(App));
}
