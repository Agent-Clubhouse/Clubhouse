import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MigrateAllHubsModal } from './MigrateAllHubsModal';

describe('MigrateAllHubsModal', () => {
  const defaultProps = {
    hubCount: 3,
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
  };

  it('renders the modal', () => {
    render(<MigrateAllHubsModal {...defaultProps} />);
    expect(screen.getByTestId('migrate-all-hubs-dialog')).toBeInTheDocument();
  });

  it('displays the hub count in the message', () => {
    render(<MigrateAllHubsModal {...defaultProps} hubCount={5} />);
    expect(screen.getByText(/all 5 of your hubs/)).toBeInTheDocument();
  });

  it('uses singular form for one hub', () => {
    render(<MigrateAllHubsModal {...defaultProps} hubCount={1} />);
    expect(screen.getByText(/your hub/)).toBeInTheDocument();
  });

  it('displays informational messages', () => {
    render(<MigrateAllHubsModal {...defaultProps} />);
    expect(screen.getByText(/Your hubs are preserved/)).toBeInTheDocument();
    expect(screen.getByText(/Re-enable anytime/)).toBeInTheDocument();
    expect(screen.getByText(/Point-in-time conversion/)).toBeInTheDocument();
  });

  it('mentions Settings > Plugins for re-enabling', () => {
    render(<MigrateAllHubsModal {...defaultProps} />);
    expect(screen.getByText(/Settings/)).toBeInTheDocument();
    expect(screen.getByText(/Plugins/)).toBeInTheDocument();
  });

  it('has Confirm and Cancel buttons', () => {
    render(<MigrateAllHubsModal {...defaultProps} />);
    expect(screen.getByTestId('migrate-all-confirm')).toBeInTheDocument();
    expect(screen.getByTestId('migrate-all-cancel')).toBeInTheDocument();
  });

  it('calls onConfirm when confirm button is clicked', () => {
    const onConfirm = vi.fn();
    render(<MigrateAllHubsModal {...defaultProps} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByTestId('migrate-all-confirm'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('calls onCancel when cancel button is clicked', () => {
    const onCancel = vi.fn();
    render(<MigrateAllHubsModal {...defaultProps} onCancel={onCancel} />);
    fireEvent.click(screen.getByTestId('migrate-all-cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('calls onCancel when backdrop is clicked', () => {
    const onCancel = vi.fn();
    render(<MigrateAllHubsModal {...defaultProps} onCancel={onCancel} />);
    fireEvent.click(screen.getByTestId('migrate-all-hubs-backdrop'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('does not call onCancel when dialog content is clicked', () => {
    const onCancel = vi.fn();
    render(<MigrateAllHubsModal {...defaultProps} onCancel={onCancel} />);
    fireEvent.click(screen.getByTestId('migrate-all-hubs-dialog'));
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('closes on Escape key', () => {
    const onCancel = vi.fn();
    render(<MigrateAllHubsModal {...defaultProps} onCancel={onCancel} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
