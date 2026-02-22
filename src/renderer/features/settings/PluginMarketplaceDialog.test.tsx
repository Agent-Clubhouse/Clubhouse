import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PluginMarketplaceDialog } from './PluginMarketplaceDialog';
import { usePluginStore } from '../../plugins/plugin-store';
import type { MarketplaceFetchResult } from '../../../shared/marketplace-types';

const sampleResult: MarketplaceFetchResult = {
  registry: {
    version: 1,
    updated: '2025-01-01T00:00:00Z',
    plugins: [
      {
        id: 'hello-world',
        name: 'Hello World',
        description: 'A simple hello world plugin',
        author: 'Clubhouse',
        official: true,
        repo: 'https://github.com/test/hello',
        path: 'plugins/hello',
        tags: ['example', 'starter'],
        latest: '0.1.0',
        releases: {
          '0.1.0': {
            api: 0.5,
            asset: 'https://example.com/hello-0.1.0.zip',
            sha256: 'abc123',
            permissions: ['logging', 'storage'],
            size: 2048,
          },
        },
      },
      {
        id: 'code-review',
        name: 'Code Review',
        description: 'AI-powered code review',
        author: 'Clubhouse',
        official: true,
        repo: 'https://github.com/test/review',
        path: 'plugins/review',
        tags: ['ai', 'code-review'],
        latest: '1.0.0',
        releases: {
          '1.0.0': {
            api: 0.5,
            asset: 'https://example.com/review-1.0.0.zip',
            sha256: 'def456',
            permissions: ['files', 'git', 'agents'],
            size: 10240,
          },
        },
      },
      {
        id: 'community-tool',
        name: 'Community Tool',
        description: 'A community contributed tool',
        author: 'Community',
        official: false,
        repo: 'https://github.com/community/tool',
        path: 'plugins/tool',
        tags: ['utility'],
        latest: '0.2.0',
        releases: {
          '0.2.0': {
            api: 0.5,
            asset: 'https://example.com/tool-0.2.0.zip',
            sha256: 'ghi789',
            permissions: [],
            size: 512,
          },
        },
      },
    ],
  },
  featured: {
    version: 1,
    updated: '2025-01-01T00:00:00Z',
    featured: [
      { id: 'code-review', reason: 'Essential for code quality' },
    ],
  },
};

beforeEach(() => {
  usePluginStore.setState({
    plugins: {},
    projectEnabled: {},
    appEnabled: [],
    modules: {},
    safeModeActive: false,
    pluginSettings: {},
    externalPluginsEnabled: false,
    permissionViolations: [],
  });
});

describe('PluginMarketplaceDialog', () => {
  it('renders loading state initially', () => {
    window.clubhouse.marketplace.fetchRegistry = vi.fn(() => new Promise(() => {})); // never resolves
    render(<PluginMarketplaceDialog onClose={vi.fn()} />);
    expect(screen.getByText('Loading marketplace...')).toBeInTheDocument();
  });

  it('renders plugin list after loading', async () => {
    window.clubhouse.marketplace.fetchRegistry = vi.fn(async () => sampleResult);
    render(<PluginMarketplaceDialog onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('Hello World')).toBeInTheDocument();
    });
    expect(screen.getByText('Code Review')).toBeInTheDocument();
    expect(screen.getByText('Community Tool')).toBeInTheDocument();
    expect(screen.getByText('3 plugin(s) available')).toBeInTheDocument();
  });

  it('renders error state on fetch failure', async () => {
    window.clubhouse.marketplace.fetchRegistry = vi.fn(async () => {
      throw new Error('Network error');
    });
    render(<PluginMarketplaceDialog onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('Failed to load marketplace')).toBeInTheDocument();
    });
    expect(screen.getByText('Network error')).toBeInTheDocument();
  });

  it('calls onClose when overlay is clicked', async () => {
    window.clubhouse.marketplace.fetchRegistry = vi.fn(async () => sampleResult);
    const onClose = vi.fn();
    render(<PluginMarketplaceDialog onClose={onClose} />);

    await waitFor(() => {
      expect(screen.getByText('Hello World')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('marketplace-overlay'));
    expect(onClose).toHaveBeenCalled();
  });

  it('calls onClose when close button is clicked', async () => {
    window.clubhouse.marketplace.fetchRegistry = vi.fn(async () => sampleResult);
    const onClose = vi.fn();
    render(<PluginMarketplaceDialog onClose={onClose} />);

    await waitFor(() => {
      expect(screen.getByText('Hello World')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('marketplace-close'));
    expect(onClose).toHaveBeenCalled();
  });

  it('does not close when dialog body is clicked', async () => {
    window.clubhouse.marketplace.fetchRegistry = vi.fn(async () => sampleResult);
    const onClose = vi.fn();
    render(<PluginMarketplaceDialog onClose={onClose} />);

    await waitFor(() => {
      expect(screen.getByText('Hello World')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('marketplace-dialog'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('filters plugins by search term', async () => {
    window.clubhouse.marketplace.fetchRegistry = vi.fn(async () => sampleResult);
    render(<PluginMarketplaceDialog onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('Hello World')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByTestId('marketplace-search'), {
      target: { value: 'code review' },
    });

    expect(screen.queryByText('Hello World')).not.toBeInTheDocument();
    expect(screen.getByText('Code Review')).toBeInTheDocument();
    expect(screen.queryByText('Community Tool')).not.toBeInTheDocument();
  });

  it('filters by tag in search', async () => {
    window.clubhouse.marketplace.fetchRegistry = vi.fn(async () => sampleResult);
    render(<PluginMarketplaceDialog onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('Hello World')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByTestId('marketplace-search'), {
      target: { value: 'starter' },
    });

    expect(screen.getByText('Hello World')).toBeInTheDocument();
    expect(screen.queryByText('Code Review')).not.toBeInTheDocument();
  });

  it('filters by featured tab', async () => {
    window.clubhouse.marketplace.fetchRegistry = vi.fn(async () => sampleResult);
    render(<PluginMarketplaceDialog onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('Hello World')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('marketplace-tab-featured'));

    expect(screen.queryByText('Hello World')).not.toBeInTheDocument();
    expect(screen.getByText('Code Review')).toBeInTheDocument();
    expect(screen.getByText('Essential for code quality')).toBeInTheDocument();
  });

  it('filters by official tab', async () => {
    window.clubhouse.marketplace.fetchRegistry = vi.fn(async () => sampleResult);
    render(<PluginMarketplaceDialog onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('Hello World')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('marketplace-tab-official'));

    expect(screen.getByText('Hello World')).toBeInTheDocument();
    expect(screen.getByText('Code Review')).toBeInTheDocument();
    expect(screen.queryByText('Community Tool')).not.toBeInTheDocument();
  });

  it('shows "Installed" badge for already installed plugins', async () => {
    usePluginStore.setState({
      plugins: {
        'hello-world': {
          manifest: { id: 'hello-world', name: 'Hello World', version: '0.1.0', engine: { api: 0.5 }, scope: 'app' },
          status: 'activated',
          source: 'community',
          pluginPath: '/test',
        },
      },
      projectEnabled: {},
      appEnabled: ['hello-world'],
      modules: {},
      safeModeActive: false,
      pluginSettings: {},
      externalPluginsEnabled: true,
      permissionViolations: [],
    });

    window.clubhouse.marketplace.fetchRegistry = vi.fn(async () => sampleResult);
    render(<PluginMarketplaceDialog onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('Hello World')).toBeInTheDocument();
    });

    // The install button for hello-world should say "Installed"
    const installButtons = screen.getAllByRole('button', { name: /Install/i });
    const installedButton = installButtons.find(
      (btn) => btn.textContent === 'Installed',
    );
    expect(installedButton).toBeDefined();
    expect(installedButton).toBeDisabled();
  });

  it('shows registry version warning when version is higher than supported', async () => {
    const futureResult: MarketplaceFetchResult = {
      registry: { ...sampleResult.registry, version: 99 },
      featured: sampleResult.featured,
    };

    window.clubhouse.marketplace.fetchRegistry = vi.fn(async () => futureResult);
    render(<PluginMarketplaceDialog onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText(/newer registry format/i)).toBeInTheDocument();
    });
  });

  it('shows empty state when search matches nothing', async () => {
    window.clubhouse.marketplace.fetchRegistry = vi.fn(async () => sampleResult);
    render(<PluginMarketplaceDialog onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('Hello World')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByTestId('marketplace-search'), {
      target: { value: 'nonexistent-xyz' },
    });

    expect(screen.getByText('No plugins match your search.')).toBeInTheDocument();
  });

  it('installs a plugin and registers it in the store', async () => {
    window.clubhouse.marketplace.fetchRegistry = vi.fn(async () => sampleResult);
    window.clubhouse.marketplace.installPlugin = vi.fn(async () => ({ success: true }));
    window.clubhouse.plugin.discoverCommunity = vi.fn(async () => [
      {
        manifest: {
          id: 'hello-world',
          name: 'Hello World',
          version: '0.1.0',
          engine: { api: 0.5 },
          scope: 'app',
        },
        pluginPath: '/home/.clubhouse/plugins/hello-world',
      },
    ]);

    render(<PluginMarketplaceDialog onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('Hello World')).toBeInTheDocument();
    });

    // Click the first Install button
    const installButtons = screen.getAllByRole('button', { name: 'Install' });
    fireEvent.click(installButtons[0]);

    await waitFor(() => {
      expect(window.clubhouse.marketplace.installPlugin).toHaveBeenCalledWith({
        pluginId: 'hello-world',
        version: '0.1.0',
        assetUrl: 'https://example.com/hello-0.1.0.zip',
        sha256: 'abc123',
      });
    });

    // After install, should rediscover and register
    await waitFor(() => {
      expect(window.clubhouse.plugin.discoverCommunity).toHaveBeenCalled();
    });
  });

  it('shows error when install fails', async () => {
    window.clubhouse.marketplace.fetchRegistry = vi.fn(async () => sampleResult);
    window.clubhouse.marketplace.installPlugin = vi.fn(async () => ({
      success: false,
      error: 'Integrity check failed',
    }));

    render(<PluginMarketplaceDialog onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('Hello World')).toBeInTheDocument();
    });

    const installButtons = screen.getAllByRole('button', { name: 'Install' });
    fireEvent.click(installButtons[0]);

    await waitFor(() => {
      expect(screen.getByText('Integrity check failed')).toBeInTheDocument();
    });
  });
});
