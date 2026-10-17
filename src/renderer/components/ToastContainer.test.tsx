import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { ToastContainer } from './ToastContainer';
import { useToastStore } from '../stores/toastStore';

describe('ToastContainer', () => {
  beforeEach(() => { useToastStore.setState({ toasts: [] }); });

  it('renders nothing without toasts', () => {
    const { container } = render(<ToastContainer />);
    expect(container.firstChild).toBeNull();
  });

  it('draws a status dot in place of glyphs, red for errors', () => {
    act(() => {
      useToastStore.getState().addToast('Saved', 'info');
      useToastStore.getState().addToast('It broke', 'error');
    });
    render(<ToastContainer />);
    const [info, error] = screen.getAllByTestId('toast-message');
    expect(info.textContent).not.toMatch(/[●✕✓]/);
    expect(info.querySelector('span[aria-hidden="true"]')!.className).toContain('bg-ctp-info');
    expect(error.querySelector('span[aria-hidden="true"]')!.className).toContain('bg-ctp-error');
    expect(info.className).toContain('bg-ctp-mantle');
    expect(info.className).toContain('rounded-lg');
  });

  it('dismisses from the close button', () => {
    act(() => { useToastStore.getState().addToast('Saved', 'info'); });
    render(<ToastContainer />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }));
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });
});
