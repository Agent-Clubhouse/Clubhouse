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

  it('is a labelled dialog with aria-modal', () => {
    render(
      <Modal open onClose={vi.fn()} title="Delete agent?">
        <span>content</span>
      </Modal>
    );
    const dialog = screen.getByRole('dialog', { name: 'Delete agent?' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
  });

  it('uses ariaLabel when there is no title row', () => {
    render(<Modal open onClose={vi.fn()} ariaLabel="Picker"><span>content</span></Modal>);
    expect(screen.getByRole('dialog', { name: 'Picker' })).toBeInTheDocument();
  });

  it('draws a 44px title row whose close button calls onClose', () => {
    const onClose = vi.fn();
    render(<Modal open onClose={onClose} title="Title"><span>content</span></Modal>);
    const close = screen.getByRole('button', { name: 'Close' });
    expect(close.parentElement!.className).toContain('h-11');
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders footer actions right-aligned', () => {
    render(<Modal open onClose={vi.fn()} footer={<button>OK</button>}><span>content</span></Modal>);
    const footer = screen.getByRole('button', { name: 'OK' }).parentElement!;
    expect(footer.className).toContain('justify-end');
  });

  it('pads the body by default and not with padding="none"', () => {
    const { rerender } = render(<Modal open onClose={vi.fn()}><span data-testid="c">c</span></Modal>);
    expect(screen.getByTestId('c').parentElement!.className).toContain('p-4');
    rerender(<Modal open onClose={vi.fn()} padding="none"><span data-testid="c">c</span></Modal>);
    expect(screen.getByTestId('c').parentElement!.className).not.toContain('p-4');
  });

  it('focuses the first control in the body, not the close button', () => {
    render(<Modal open onClose={vi.fn()} title="T"><input data-testid="field" /></Modal>);
    expect(document.activeElement).toBe(screen.getByTestId('field'));
  });

  it('focuses initialFocusRef when given', () => {
    function Harness() {
      const ref = { current: null as HTMLButtonElement | null };
      return (
        <Modal open onClose={vi.fn()} initialFocusRef={ref}>
          <input />
          <button ref={(el) => { ref.current = el; }}>Confirm</button>
        </Modal>
      );
    }
    render(<Harness />);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Confirm' }));
  });

  it('keeps an autofocused field focused', () => {
    render(<Modal open onClose={vi.fn()}><button>first</button><input autoFocus data-testid="auto" /></Modal>);
    expect(document.activeElement).toBe(screen.getByTestId('auto'));
  });

  it('traps Tab inside the dialog', () => {
    render(
      <Modal open onClose={vi.fn()}>
        <button>one</button>
        <button>two</button>
      </Modal>
    );
    const one = screen.getByRole('button', { name: 'one' });
    const two = screen.getByRole('button', { name: 'two' });
    expect(document.activeElement).toBe(one);
    two.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(one);
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(two);
  });

  it('returns focus to the opener on close', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const { rerender } = render(<Modal open onClose={vi.fn()}><button>inside</button></Modal>);
    expect(document.activeElement).not.toBe(opener);
    rerender(<Modal open={false} onClose={vi.fn()}><button>inside</button></Modal>);
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('closes only the topmost modal on Esc', () => {
    const outer = vi.fn();
    const inner = vi.fn();
    render(
      <>
        <Modal open onClose={outer}><span>outer</span></Modal>
        <Modal open onClose={inner}><span>inner</span></Modal>
      </>
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
  });
});
