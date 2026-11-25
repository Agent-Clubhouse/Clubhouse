import type { PluginManifest } from '../../../../shared/plugin-types';

const BROWSER_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`;

export { BROWSER_ICON };

export const manifest: PluginManifest = {
  id: 'browser',
  name: 'Browser',
  version: '1.0.0',
  description: 'Embedded browser for testing web applications and inspecting local files.',
  author: 'Clubhouse',
  engine: { api: 0.9 },
  scope: 'dual',
  permissions: ['commands', 'storage', 'canvas', 'widgets', 'projects'],
  contributes: {
    tab: { label: 'Browser', title: 'Browser', icon: BROWSER_ICON, layout: 'sidebar-content' },
    canvasWidgets: [
      {
        id: 'webview',
        label: 'Browser',
        icon: BROWSER_ICON,
        defaultSize: { width: 640, height: 480 },
        metadataKeys: ['url'],
      },
    ],
    settings: [
      {
        key: 'allowLocalhost',
        type: 'boolean',
        label: 'Allow localhost',
        description: 'Enable loading http://localhost and http://127.0.0.1 URLs for local development.',
        default: false,
      },
      {
        key: 'allowFileProtocol',
        type: 'boolean',
        label: 'Allow file:// URLs',
        description: 'Enable loading local files via the file:// protocol. Off by default.',
        default: false,
      },
    ],
    commands: [
      { id: 'reload', title: 'Reload Page' },
      { id: 'devtools', title: 'Toggle DevTools' },
    ],
    help: {
      topics: [
        {
          id: 'browser',
          title: 'Browser',
          content: [
            '## Browser',
            '',
            'The Browser tab provides an embedded web browser for testing web applications and inspecting local files.',
            '',
            '### Supported protocols',
            '- **HTTPS** \u2014 Always enabled. Enter any https:// URL to load.',
            '- **Localhost** \u2014 Enable in settings to load http://localhost and http://127.0.0.1 for local dev servers.',
            '- **File** \u2014 Enable in settings to load local files via file:// URLs.',
            '',
            '### Navigation',
            '- Use the address bar to enter URLs. Press **Enter** to navigate.',
            '- Use the **Back**, **Forward**, and **Reload** buttons for standard navigation.',
            '- URLs without a protocol prefix default to https://.',
            '',
            '### DevTools',
            '- Click the **DevTools** button to open Chrome DevTools for the current page.',
            '- DevTools opens in a separate window for full inspection capabilities.',
            '',
            '### Canvas widget',
            '- Add a Browser widget to the canvas for a standalone browsing instance.',
            '- Each canvas widget is an independent browser session.',
            '',
            '### Settings',
            '- **Allow localhost** \u2014 Toggle loading of http://localhost and http://127.0.0.1.',
            '- **Allow file:// URLs** \u2014 Toggle loading of local files. Off by default. This is the only setting for local files.',
            '',
            '### Safety',
            '- Pages run sandboxed, without Node.js access or app scripts.',
            '- Clubhouse checks page loads, links and redirects. Pages can open http and https addresses, and file:// only when **Allow file:// URLs** is on for this project (or, on the app canvas, for the app). Other kinds of address are blocked.',
            '- Pages can\'t open new windows or popups. A link that would open one does nothing.',
          ].join('\n'),
        },
      ],
    },
  },
  settingsPanel: 'declarative',
};
