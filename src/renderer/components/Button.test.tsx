import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Button } from './Button';

describe('Button', () => {
  it('defaults to a 28px ghost button of type button', () => {
    render(<Button>Cancel</Button>);
    const b = screen.getByRole('button', { name: 'Cancel' });
    expect(b).toHaveAttribute('type', 'button');
    expect(b).toHaveAttribute('data-kind', 'ghost');
    expect(b.className).toContain('h-7');
    expect(b.className).toContain('rounded-md');
    expect(b.className).toContain('text-xs');
    expect(b.className).toContain('border-surface-1');
  });

  it.each([
    ['primary', 'bg-ctp-accent', 'text-ctp-crust'],
    ['ghost', 'border-surface-1', 'text-ctp-subtext1'],
    ['quiet', 'border-transparent', 'text-ctp-subtext1'],
    ['danger', 'border-surface-1', 'text-ctp-red'],
    ['danger-solid', 'bg-ctp-red', 'text-ctp-crust'],
  ] as const)('styles the %s kind', (kind, a, b) => {
    render(<Button kind={kind}>Go</Button>);
    const el = screen.getByRole('button');
    expect(el.className).toContain(a);
    expect(el.className).toContain(b);
  });

  it('is square when it has only an icon', () => {
    render(<Button kind="quiet" icon={<svg />} aria-label="Pop out" />);
    const b = screen.getByRole('button', { name: 'Pop out' });
    expect(b.className).toContain('w-7');
    expect(b.className).toContain('px-0');
  });

  it('pads a labelled button with an icon', () => {
    render(<Button icon={<svg />}>Pop out</Button>);
    expect(screen.getByRole('button').className).toContain('px-2.5');
  });

  it('forwards clicks, refs and props, and respects disabled', () => {
    const onClick = vi.fn();
    const ref = { current: null as HTMLButtonElement | null };
    const { rerender } = render(<Button ref={ref} onClick={onClick} data-testid="b" type="submit">Save</Button>);
    fireEvent.click(screen.getByTestId('b'));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(ref.current).toBe(screen.getByTestId('b'));
    expect(screen.getByTestId('b')).toHaveAttribute('type', 'submit');
    rerender(<Button onClick={onClick} data-testid="b" disabled>Save</Button>);
    fireEvent.click(screen.getByTestId('b'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
