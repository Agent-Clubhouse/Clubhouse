import type { PluginManifest } from '../../../../shared/plugin-types';

export const manifest: PluginManifest = {
  id: 'hello-world',
  name: 'Hello World',
  version: '0.1.0',
  description: 'A skeleton built-in plugin demonstrating the pattern.',
  author: 'Clubhouse',
  engine: { api: 0.2 },
  scope: 'app',
  contributes: {
    commands: [{ id: 'greet', title: 'Say Hello' }],
    settings: [
      {
        key: 'greeting',
        type: 'string',
        label: 'Greeting message',
        default: 'Hello from a built-in plugin!',
      },
    ],
  },
  settingsPanel: 'declarative',
};
