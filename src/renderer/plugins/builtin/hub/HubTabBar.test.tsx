import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { HubTabBar } from './HubTabBar';
import type { HubInstance } from './useHubStore';
import type { LeafPane } from './pane-tree';

const noop = () => {};

function makeHub(id: string, name: string): HubInstance {
  const leaf: LeafPane = { type: 'leaf', id: `pane_${id}`, agentId: null };
  return { id, name, paneTree: leaf, focusedPaneId: leaf.id, zoomedPaneId: null };
}

describe('HubTabBar', () => {
  it('renders all hub tabs', () => {
    const hubs = [makeHub('h1', 'alpha-garden'), makeHub('h2', 'beta-market')];
    render(
      <HubTabBar
        hubs={hubs}
        activeHubId="h1"
        onSelectHub={noop}
        onAddHub={noop}
        onRemoveHub={noop}
        onRenameHub={noop}
        onPopOutHub={noop}
      />,
    );
    expect(screen.getByText('alpha-garden')).toBeInTheDocument();
    expect(screen.getByText('beta-market')).toBeInTheDocument();
  });

  it('renders add button', () => {
    render(
      <HubTabBar
        hubs={[makeHub('h1', 'test-hub')]}
        activeHubId="h1"
        onSelectHub={noop}
        onAddHub={noop}
        onRemoveHub={noop}
        onRenameHub={noop}
        onPopOutHub={noop}
      />,
    );
    expect(screen.getByTestId('hub-add-button')).toBeInTheDocument();
  });

  it('calls onAddHub when add button is clicked', () => {
    const onAddHub = vi.fn();
    render(
      <HubTabBar
        hubs={[makeHub('h1', 'test-hub')]}
        activeHubId="h1"
        onSelectHub={noop}
        onAddHub={onAddHub}
        onRemoveHub={noop}
        onRenameHub={noop}
        onPopOutHub={noop}
      />,
    );
    fireEvent.click(screen.getByTestId('hub-add-button'));
    expect(onAddHub).toHaveBeenCalledTimes(1);
  });

  it('calls onSelectHub when a tab is clicked', () => {
    const onSelectHub = vi.fn();
    const hubs = [makeHub('h1', 'first'), makeHub('h2', 'second')];
    render(
      <HubTabBar
        hubs={hubs}
        activeHubId="h1"
        onSelectHub={onSelectHub}
        onAddHub={noop}
        onRemoveHub={noop}
        onRenameHub={noop}
        onPopOutHub={noop}
      />,
    );
    fireEvent.click(screen.getByText('second'));
    expect(onSelectHub).toHaveBeenCalledWith('h2');
  });

  it('shows close button on hover when multiple hubs exist', () => {
    const hubs = [makeHub('h1', 'first'), makeHub('h2', 'second')];
    render(
      <HubTabBar
        hubs={hubs}
        activeHubId="h1"
        onSelectHub={noop}
        onAddHub={noop}
        onRemoveHub={noop}
        onRenameHub={noop}
        onPopOutHub={noop}
      />,
    );
    // Hover the active tab
    fireEvent.mouseEnter(screen.getByTestId('hub-tab-h1'));
    expect(screen.getByTestId('hub-tab-close')).toBeInTheDocument();
  });

  it('calls onRemoveHub when close button clicked', () => {
    const onRemoveHub = vi.fn();
    const hubs = [makeHub('h1', 'first'), makeHub('h2', 'second')];
    render(
      <HubTabBar
        hubs={hubs}
        activeHubId="h1"
        onSelectHub={noop}
        onAddHub={noop}
        onRemoveHub={onRemoveHub}
        onRenameHub={noop}
        onPopOutHub={noop}
      />,
    );
    fireEvent.mouseEnter(screen.getByTestId('hub-tab-h1'));
    fireEvent.click(screen.getByTestId('hub-tab-close'));
    expect(onRemoveHub).toHaveBeenCalledWith('h1');
  });

  it('shows pop-out button on hover', () => {
    const hubs = [makeHub('h1', 'test-hub')];
    render(
      <HubTabBar
        hubs={hubs}
        activeHubId="h1"
        onSelectHub={noop}
        onAddHub={noop}
        onRemoveHub={noop}
        onRenameHub={noop}
        onPopOutHub={noop}
      />,
    );
    fireEvent.mouseEnter(screen.getByTestId('hub-tab-h1'));
    expect(screen.getByTestId('hub-tab-popout')).toBeInTheDocument();
  });

  it('calls onPopOutHub when pop-out button clicked', () => {
    const onPopOutHub = vi.fn();
    const hubs = [makeHub('h1', 'test-hub')];
    render(
      <HubTabBar
        hubs={hubs}
        activeHubId="h1"
        onSelectHub={noop}
        onAddHub={noop}
        onRemoveHub={noop}
        onRenameHub={noop}
        onPopOutHub={onPopOutHub}
      />,
    );
    fireEvent.mouseEnter(screen.getByTestId('hub-tab-h1'));
    fireEvent.click(screen.getByTestId('hub-tab-popout'));
    expect(onPopOutHub).toHaveBeenCalledWith('h1', 'test-hub');
  });

  it('enters rename mode on double-click', () => {
    const hubs = [makeHub('h1', 'test-hub')];
    render(
      <HubTabBar
        hubs={hubs}
        activeHubId="h1"
        onSelectHub={noop}
        onAddHub={noop}
        onRemoveHub={noop}
        onRenameHub={noop}
        onPopOutHub={noop}
      />,
    );
    fireEvent.doubleClick(screen.getByTestId('hub-tab-h1'));
    expect(screen.getByTestId('hub-tab-rename-input')).toBeInTheDocument();
  });

  it('commits rename on Enter', () => {
    const onRenameHub = vi.fn();
    const hubs = [makeHub('h1', 'test-hub')];
    render(
      <HubTabBar
        hubs={hubs}
        activeHubId="h1"
        onSelectHub={noop}
        onAddHub={noop}
        onRemoveHub={noop}
        onRenameHub={onRenameHub}
        onPopOutHub={noop}
      />,
    );
    fireEvent.doubleClick(screen.getByTestId('hub-tab-h1'));
    const input = screen.getByTestId('hub-tab-rename-input');
    fireEvent.change(input, { target: { value: 'new-name' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onRenameHub).toHaveBeenCalledWith('h1', 'new-name');
  });

  it('cancels rename on Escape', () => {
    const onRenameHub = vi.fn();
    const hubs = [makeHub('h1', 'test-hub')];
    render(
      <HubTabBar
        hubs={hubs}
        activeHubId="h1"
        onSelectHub={noop}
        onAddHub={noop}
        onRemoveHub={noop}
        onRenameHub={onRenameHub}
        onPopOutHub={noop}
      />,
    );
    fireEvent.doubleClick(screen.getByTestId('hub-tab-h1'));
    const input = screen.getByTestId('hub-tab-rename-input');
    fireEvent.change(input, { target: { value: 'new-name' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onRenameHub).not.toHaveBeenCalled();
    // Should exit edit mode and show original name
    expect(screen.getByText('test-hub')).toBeInTheDocument();
  });
});
