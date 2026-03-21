import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { UpgradeToCanvasDialog } from './UpgradeToCanvasDialog';

describe('UpgradeToCanvasDialog', () => {
  const defaultProps = {
    hubName: 'My Hub',
    onUpgrade: vi.fn(),
    onUpgradeAndDelete: vi.fn(),
    onClose: vi.fn(),
  };

  it('renders the dialog with hub name', () => {
    render(<UpgradeToCanvasDialog {...defaultProps} />);
    expect(screen.getByTestId('upgrade-to-canvas-dialog')).toBeInTheDocument();
    expect(screen.getByText(/My Hub/)).toBeInTheDocument();
  });

  it('displays informational warnings', () => {
    render(<UpgradeToCanvasDialog {...defaultProps} />);
    expect(screen.getByText(/Point-in-time conversion/)).toBeInTheDocument();
    expect(screen.getByText(/One-way/)).toBeInTheDocument();
  });

  it('has Upgrade, Upgrade & Delete, and Cancel buttons', () => {
    render(<UpgradeToCanvasDialog {...defaultProps} />);
    expect(screen.getByTestId('upgrade-keep')).toBeInTheDocument();
    expect(screen.getByTestId('upgrade-and-delete')).toBeInTheDocument();
    expect(screen.getByTestId('upgrade-cancel')).toBeInTheDocument();
  });

  it('calls onUpgrade when Upgrade button is clicked', () => {
    const onUpgrade = vi.fn();
    render(<UpgradeToCanvasDialog {...defaultProps} onUpgrade={onUpgrade} />);
    fireEvent.click(screen.getByTestId('upgrade-keep'));
    expect(onUpgrade).toHaveBeenCalledTimes(1);
  });

  it('calls onUpgradeAndDelete when Upgrade & Delete button is clicked', () => {
    const onUpgradeAndDelete = vi.fn();
    render(<UpgradeToCanvasDialog {...defaultProps} onUpgradeAndDelete={onUpgradeAndDelete} />);
    fireEvent.click(screen.getByTestId('upgrade-and-delete'));
    expect(onUpgradeAndDelete).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when Cancel is clicked', () => {
    const onClose = vi.fn();
    render(<UpgradeToCanvasDialog {...defaultProps} onClose={onClose} />);
    fireEvent.click(screen.getByTestId('upgrade-cancel'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when backdrop is clicked', () => {
    const onClose = vi.fn();
    render(<UpgradeToCanvasDialog {...defaultProps} onClose={onClose} />);
    fireEvent.click(screen.getByTestId('upgrade-to-canvas-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not call onClose when dialog content is clicked', () => {
    const onClose = vi.fn();
    render(<UpgradeToCanvasDialog {...defaultProps} onClose={onClose} />);
    fireEvent.click(screen.getByTestId('upgrade-to-canvas-dialog'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes on Escape key', () => {
    const onClose = vi.fn();
    render(<UpgradeToCanvasDialog {...defaultProps} onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
