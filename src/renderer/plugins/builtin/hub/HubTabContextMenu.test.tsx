import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { HubTabContextMenu } from './HubTabContextMenu';

describe('HubTabContextMenu', () => {
  const defaultProps = {
    x: 100,
    y: 200,
    hubId: 'hub-1',
    onUpgradeToCanvas: vi.fn(),
    onDuplicate: vi.fn(),
    onClose: vi.fn(),
  };

  it('renders the context menu', () => {
    render(<HubTabContextMenu {...defaultProps} />);
    expect(screen.getByTestId('hub-tab-context-menu')).toBeInTheDocument();
  });

  it('renders Upgrade to Canvas option', () => {
    render(<HubTabContextMenu {...defaultProps} />);
    expect(screen.getByTestId('hub-ctx-upgrade-to-canvas')).toBeInTheDocument();
    expect(screen.getByText('Upgrade to Canvas')).toBeInTheDocument();
  });

  it('renders Duplicate option', () => {
    render(<HubTabContextMenu {...defaultProps} />);
    expect(screen.getByTestId('hub-ctx-duplicate')).toBeInTheDocument();
    expect(screen.getByText('Duplicate')).toBeInTheDocument();
  });

  it('calls onUpgradeToCanvas with hubId when clicked', () => {
    const onUpgradeToCanvas = vi.fn();
    render(<HubTabContextMenu {...defaultProps} onUpgradeToCanvas={onUpgradeToCanvas} />);
    fireEvent.click(screen.getByTestId('hub-ctx-upgrade-to-canvas'));
    expect(onUpgradeToCanvas).toHaveBeenCalledWith('hub-1');
  });

  it('calls onDuplicate with hubId when clicked', () => {
    const onDuplicate = vi.fn();
    render(<HubTabContextMenu {...defaultProps} onDuplicate={onDuplicate} />);
    fireEvent.click(screen.getByTestId('hub-ctx-duplicate'));
    expect(onDuplicate).toHaveBeenCalledWith('hub-1');
  });

  it('calls onClose after clicking an option', () => {
    const onClose = vi.fn();
    render(<HubTabContextMenu {...defaultProps} onClose={onClose} />);
    fireEvent.click(screen.getByTestId('hub-ctx-upgrade-to-canvas'));
    expect(onClose).toHaveBeenCalled();
  });

  it('closes on Escape key', () => {
    const onClose = vi.fn();
    render(<HubTabContextMenu {...defaultProps} onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('closes on click outside', () => {
    const onClose = vi.fn();
    render(<HubTabContextMenu {...defaultProps} onClose={onClose} />);
    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalled();
  });

  it('does not close on click inside', () => {
    const onClose = vi.fn();
    render(<HubTabContextMenu {...defaultProps} onClose={onClose} />);
    fireEvent.mouseDown(screen.getByTestId('hub-tab-context-menu'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('positions the menu at provided coordinates', () => {
    render(<HubTabContextMenu {...defaultProps} x={150} y={250} />);
    const menu = screen.getByTestId('hub-tab-context-menu');
    expect(menu.style.left).toBe('150px');
    expect(menu.style.top).toBe('250px');
  });

  it('hides Upgrade to Canvas when onUpgradeToCanvas is not provided', () => {
    render(
      <HubTabContextMenu
        x={100}
        y={200}
        hubId="hub-1"
        onDuplicate={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('hub-ctx-upgrade-to-canvas')).not.toBeInTheDocument();
    expect(screen.getByTestId('hub-ctx-duplicate')).toBeInTheDocument();
  });

  it('shows only Duplicate when canvas is not enabled', () => {
    render(
      <HubTabContextMenu
        x={100}
        y={200}
        hubId="hub-1"
        onDuplicate={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByText('Upgrade to Canvas')).not.toBeInTheDocument();
    expect(screen.getByText('Duplicate')).toBeInTheDocument();
  });
});
