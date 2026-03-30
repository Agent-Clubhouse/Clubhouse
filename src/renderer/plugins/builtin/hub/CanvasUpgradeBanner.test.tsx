import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { CanvasUpgradeBanner } from './CanvasUpgradeBanner';

describe('CanvasUpgradeBanner', () => {
  const defaultProps = {
    onMigrateAll: vi.fn(),
    onDismiss: vi.fn(),
  };

  it('renders the banner', () => {
    render(<CanvasUpgradeBanner {...defaultProps} />);
    expect(screen.getByTestId('canvas-upgrade-banner')).toBeInTheDocument();
  });

  it('displays canvas promotion text', () => {
    render(<CanvasUpgradeBanner {...defaultProps} />);
    expect(screen.getByText('Canvas is here')).toBeInTheDocument();
    expect(screen.getByText(/next-generation Hub/)).toBeInTheDocument();
    expect(screen.getByText(/Right-click any hub tab/)).toBeInTheDocument();
  });

  it('has a "Move All Hubs to Canvas" button', () => {
    render(<CanvasUpgradeBanner {...defaultProps} />);
    expect(screen.getByTestId('canvas-upgrade-migrate-all')).toBeInTheDocument();
    expect(screen.getByText('Move All Hubs to Canvas')).toBeInTheDocument();
  });

  it('calls onMigrateAll when the migrate button is clicked', () => {
    const onMigrateAll = vi.fn();
    render(<CanvasUpgradeBanner {...defaultProps} onMigrateAll={onMigrateAll} />);
    fireEvent.click(screen.getByTestId('canvas-upgrade-migrate-all'));
    expect(onMigrateAll).toHaveBeenCalledTimes(1);
  });

  it('has a dismiss button', () => {
    render(<CanvasUpgradeBanner {...defaultProps} />);
    expect(screen.getByTestId('canvas-upgrade-dismiss')).toBeInTheDocument();
  });

  it('calls onDismiss when the dismiss button is clicked', () => {
    const onDismiss = vi.fn();
    render(<CanvasUpgradeBanner {...defaultProps} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByTestId('canvas-upgrade-dismiss'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
