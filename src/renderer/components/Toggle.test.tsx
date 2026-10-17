import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Toggle } from './Toggle';

describe('Toggle', () => {
  it('is a switch whose aria-checked follows checked', () => {
    const { rerender } = render(<Toggle checked={false} onChange={() => {}} ariaLabel="Sounds" />);
    const sw = screen.getByRole('switch', { name: 'Sounds' });
    expect(sw).toHaveAttribute('aria-checked', 'false');
    expect(sw).toHaveAttribute('data-on', 'false');
    rerender(<Toggle checked onChange={() => {}} ariaLabel="Sounds" />);
    expect(sw).toHaveAttribute('aria-checked', 'true');
    expect(sw).toHaveAttribute('data-on', 'true');
  });

  it('uses the accent track when on and surface-1 when off', () => {
    const { rerender } = render(<Toggle checked={false} onChange={() => {}} />);
    expect(screen.getByRole('switch').className).toContain('bg-surface-1');
    rerender(<Toggle checked onChange={() => {}} />);
    expect(screen.getByRole('switch').className).toContain('bg-ctp-accent');
  });

  it('is 28x16 with a 12px knob that slides when on', () => {
    const { rerender } = render(<Toggle checked={false} onChange={() => {}} />);
    const sw = screen.getByRole('switch');
    expect(sw.className).toContain('w-7');
    expect(sw.className).toContain('h-4');
    const knob = sw.querySelector('span')!;
    expect(knob.className).toContain('w-3');
    expect(knob.className).toContain('translate-x-0');
    rerender(<Toggle checked onChange={() => {}} />);
    expect(sw.querySelector('span')!.className).toContain('translate-x-3');
  });

  it('calls onChange with the toggled value', () => {
    const onChange = vi.fn();
    const { rerender } = render(<Toggle checked={false} onChange={onChange} />);
    fireEvent.click(screen.getByRole('switch'));
    expect(onChange).toHaveBeenLastCalledWith(true);
    rerender(<Toggle checked onChange={onChange} />);
    fireEvent.click(screen.getByRole('switch'));
    expect(onChange).toHaveBeenLastCalledWith(false);
  });

  it('does not call onChange when disabled', () => {
    const onChange = vi.fn();
    render(<Toggle checked={false} onChange={onChange} disabled />);
    const sw = screen.getByRole('switch');
    expect(sw).toBeDisabled();
    expect(sw.className).toContain('opacity-50');
    fireEvent.click(sw);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('passes through extra button props', () => {
    render(<Toggle checked={false} onChange={() => {}} data-testid="t" aria-labelledby="lbl" />);
    expect(screen.getByTestId('t')).toHaveAttribute('aria-labelledby', 'lbl');
  });
});
