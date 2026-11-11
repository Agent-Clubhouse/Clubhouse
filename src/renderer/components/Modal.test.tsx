import { useState } from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

  it('uses aria-label when there is no title row', () => {
    render(<Modal open onClose={vi.fn()} aria-label="Picker"><span>content</span></Modal>);
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

  it('leaves Tab alone while focus is in a portaled menu or tooltip', () => {
    const popup = document.createElement('div');
    popup.setAttribute('data-layer-portal', '');
    const item = document.createElement('button');
    popup.appendChild(item);
    document.body.appendChild(popup);
    render(<Modal open onClose={vi.fn()}><button>one</button></Modal>);
    item.focus();
    const e = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    document.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(item);
    popup.remove();
  });

  it('ignores an Esc that a popup already handled', () => {
    const onClose = vi.fn();
    render(<Modal open onClose={onClose}><button>one</button></Modal>);
    const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    e.preventDefault();
    document.dispatchEvent(e);
    expect(onClose).not.toHaveBeenCalled();
  });

  describe('state-aware dismissal', () => {
    const ways = ['Escape', 'backdrop', 'Close', 'Cancel'] as const;
    function dismiss(way: typeof ways[number]) {
      const dialog = screen.getByRole('dialog', { name: 'Editor' });
      if (way === 'Escape') fireEvent.keyDown(document, { key: 'Escape' });
      else if (way === 'backdrop') fireEvent.click(dialog.parentElement!);
      else fireEvent.click(within(dialog).getByRole('button', { name: way }));
    }

    function editor(onClose: () => void, dirty = false, busy = false) {
      return <Modal open onClose={onClose} dirty={dirty} busy={busy} title="Editor" footer={(requestClose) => <button onClick={requestClose}>Cancel</button>}>
        <input aria-label="Draft" defaultValue="Unsaved work" />
      </Modal>;
    }

    it.each(ways)('closes a pristine dialog via %s', (way) => {
      const onClose = vi.fn();
      render(editor(onClose));
      dismiss(way);
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('dialog', { name: 'Discard changes?' })).toBeNull();
    });

    it.each(ways)('asks before discarding dirty work via %s', (way) => {
      const onClose = vi.fn();
      render(editor(onClose, true));
      dismiss(way);
      expect(onClose).not.toHaveBeenCalled();
      expect(screen.getByRole('dialog', { name: 'Discard changes?' })).toBeInTheDocument();
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Keep editing' }));
      fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
      expect(screen.getByLabelText('Draft')).toHaveValue('Unsaved work');
      expect(onClose).not.toHaveBeenCalled();
      dismiss(way);
      fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it.each(ways)('blocks %s while busy, even if dirty, and uses the latest state', (way) => {
      const onClose = vi.fn();
      const { rerender } = render(editor(onClose));
      rerender(editor(onClose, true, true));
      dismiss(way);
      expect(onClose).not.toHaveBeenCalled();
      expect(screen.queryByRole('dialog', { name: 'Discard changes?' })).toBeNull();
      rerender(editor(onClose));
      dismiss(way);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it.each(['Escape', 'backdrop', 'Close'] as const)('dismisses only the discard prompt via %s and restores focus', async (way) => {
      const user = userEvent.setup();
      const onClose = vi.fn();
      render(editor(onClose, true));
      const cancel = screen.getByRole('button', { name: 'Cancel' });
      cancel.focus();
      dismiss('Cancel');
      const prompt = screen.getByRole('dialog', { name: 'Discard changes?' });
      if (way === 'Escape') await user.keyboard('{Escape}');
      else if (way === 'backdrop') fireEvent.click(prompt.parentElement!);
      else fireEvent.click(within(prompt).getByRole('button', { name: 'Close' }));
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Discard changes?' })).toBeNull());
      expect(onClose).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(cancel);
    });

    it('blocks an open discard prompt if the editor becomes busy', () => {
      const onClose = vi.fn();
      const { rerender } = render(editor(onClose, true));
      dismiss('Escape');
      rerender(editor(onClose, true, true));
      fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(screen.getByRole('dialog', { name: 'Discard changes?' })).toBeInTheDocument();
      expect(onClose).not.toHaveBeenCalled();
    });

    it('traps keyboard focus in the discard prompt and restores the editor field on Escape', async () => {
      const user = userEvent.setup();
      const onClose = vi.fn();
      render(editor(onClose, true));
      const draft = screen.getByLabelText('Draft');
      expect(draft).toHaveFocus();
      await user.keyboard('{Escape}');
      expect(screen.getByRole('button', { name: 'Keep editing' })).toHaveFocus();
      await user.tab();
      expect(screen.getByRole('button', { name: 'Discard changes' })).toHaveFocus();
      await user.tab();
      expect(within(screen.getByRole('dialog', { name: 'Discard changes?' })).getByRole('button', { name: 'Close' })).toHaveFocus();
      await user.tab({ shift: true });
      expect(screen.getByRole('button', { name: 'Discard changes' })).toHaveFocus();
      await user.keyboard('{Escape}');
      expect(draft).toHaveFocus();
      expect(onClose).not.toHaveBeenCalled();
    });

    it('returns focus to the opener after confirming discard closes both dialogs', async () => {
      const user = userEvent.setup();
      function Harness() {
        const [open, setOpen] = useState(false);
        return <>
          <button onClick={() => setOpen(true)}>Open editor</button>
          <Modal open={open} onClose={() => setOpen(false)} dirty title="Editor">
            <input aria-label="Draft" defaultValue="Unsaved work" />
          </Modal>
        </>;
      }
      render(<Harness />);
      const opener = screen.getByRole('button', { name: 'Open editor' });
      await user.click(opener);
      await user.keyboard('{Escape}');
      await user.click(screen.getByRole('button', { name: 'Discard changes' }));
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(opener).toHaveFocus();
    });
  });

  describe('onDismiss', () => {
    function open() {
      const onClose = vi.fn();
      const onDismiss = vi.fn();
      render(<Modal open onClose={onClose} onDismiss={onDismiss} title="Title"><button>one</button></Modal>);
      return { onClose, onDismiss };
    }

    it('takes Esc instead of onClose', () => {
      const { onClose, onDismiss } = open();
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(onDismiss).toHaveBeenCalledTimes(1);
      expect(onClose).not.toHaveBeenCalled();
    });

    it('takes a backdrop click instead of onClose', () => {
      const { onClose, onDismiss } = open();
      fireEvent.click(screen.getByRole('dialog').parentElement as HTMLElement);
      expect(onDismiss).toHaveBeenCalledTimes(1);
      expect(onClose).not.toHaveBeenCalled();
    });

    it('leaves the close button to onClose', () => {
      const { onClose, onDismiss } = open();
      fireEvent.click(screen.getByRole('button', { name: 'Close' }));
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(onDismiss).not.toHaveBeenCalled();
    });

    it('doesn\'t see a click inside the panel', () => {
      const { onClose, onDismiss } = open();
      fireEvent.click(screen.getByRole('button', { name: 'one' }));
      expect(onDismiss).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
    });
  });
});
