import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { Toggle } from './Toggle';

describe('Toggle', () => {
  it('renders unchecked state with bg-surface-2', () => {
    const { container } = render(<Toggle checked={false} onChange={() => {}} />);
    const button = container.querySelector('button')!;
    expect(button.className).toContain('bg-surface-2');
    expect(button.className).not.toContain('bg-ctp-accent');
  });

  it('renders checked state with bg-ctp-accent', () => {
    const { container } = render(<Toggle checked={true} onChange={() => {}} />);
    const button = container.querySelector('button')!;
    expect(button.className).toContain('bg-ctp-accent');
  });

  it('calls onChange with toggled value on click', () => {
    const onChange = vi.fn();
    const { container } = render(<Toggle checked={false} onChange={onChange} />);
    fireEvent.click(container.querySelector('button')!);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('calls onChange with false when checked is true', () => {
    const onChange = vi.fn();
    const { container } = render(<Toggle checked={true} onChange={onChange} />);
    fireEvent.click(container.querySelector('button')!);
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it('does not call onChange when disabled', () => {
    const onChange = vi.fn();
    const { container } = render(<Toggle checked={false} onChange={onChange} disabled />);
    fireEvent.click(container.querySelector('button')!);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('applies disabled styling', () => {
    const { container } = render(<Toggle checked={false} onChange={() => {}} disabled />);
    const button = container.querySelector('button')!;
    expect(button.className).toContain('opacity-40');
    expect(button.className).toContain('cursor-not-allowed');
  });

  it('translates knob when checked', () => {
    const { container } = render(<Toggle checked={true} onChange={() => {}} />);
    const knob = container.querySelector('span')!;
    expect(knob.className).toContain('translate-x-4');
  });

  it('does not translate knob when unchecked', () => {
    const { container } = render(<Toggle checked={false} onChange={() => {}} />);
    const knob = container.querySelector('span')!;
    expect(knob.className).toContain('translate-x-0');
  });
});
