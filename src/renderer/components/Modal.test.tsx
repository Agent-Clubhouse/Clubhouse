import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { Modal } from './Modal';

describe('Modal', () => {
  it('renders nothing when open=false', () => {
    const { container } = render(
      <Modal open={false} onClose={vi.fn()}>
        <span>content</span>
      </Modal>
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders children when open=true', () => {
    render(
      <Modal open={true} onClose={vi.fn()}>
        <span>hello modal</span>
      </Modal>
    );
    expect(screen.getByText('hello modal')).toBeInTheDocument();
  });

  it('calls onClose when Escape is pressed', () => {
    const onClose = vi.fn();
    render(
      <Modal open={true} onClose={onClose}>
        <span>content</span>
      </Modal>
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not register Escape handler when open=false', () => {
    const onClose = vi.fn();
    render(
      <Modal open={false} onClose={onClose}>
        <span>content</span>
      </Modal>
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('calls onClose when backdrop is clicked', () => {
    const onClose = vi.fn();
    render(
      <Modal open={true} onClose={onClose}>
        <span>content</span>
      </Modal>
    );
    // Click the outermost fixed backdrop div (data-testid via aria or first child)
    const backdrop = document.querySelector('.fixed.inset-0') as HTMLElement;
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not call onClose when the inner panel is clicked', () => {
    const onClose = vi.fn();
    render(
      <Modal open={true} onClose={onClose}>
        <span data-testid="inner">inner content</span>
      </Modal>
    );
    fireEvent.click(screen.getByTestId('inner'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('portals the backdrop directly under document.body with the z-modal class (regression: settings rows above modal)', () => {
    render(
      <Modal open={true} onClose={vi.fn()}>
        <span>content</span>
      </Modal>
    );
    const backdrop = document.querySelector('.fixed.inset-0') as HTMLElement;
    expect(backdrop).not.toBeNull();
    // Must portal to body so it escapes ancestor stacking contexts in
    // settings/explorer panels.
    expect(backdrop.parentElement).toBe(document.body);
    // Must carry the named z-index utility — if this class disappears (or
    // its Tailwind utility stops compiling) the modal falls back to
    // z-index: auto and settings content renders above it.
    expect(backdrop.classList.contains('z-modal')).toBe(true);
  });
});
