import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { claudeContextWindowOptions, copilotContextWindowOptions } from '../../../shared/context-window';
import { ContextWindowSelect, contextSummary, contextWindowHelp, formatContextChoice } from './ContextWindowField';

describe('ContextWindowSelect', () => {
  const options = claudeContextWindowOptions('claude-haiku-4-5');

  it('labels the control as what it is, with only what the model offers', () => {
    render(<ContextWindowSelect options={options} value={undefined} className="" onChange={() => {}} />);
    const select = screen.getByRole('combobox', { name: 'Working context' });
    expect(Array.from((select as HTMLSelectElement).options).map((o) => o.text)).toEqual(['Auto', '100K', '200K']);
  });

  it('saves a choice, and no choice as null', () => {
    const onChange = vi.fn();
    render(<ContextWindowSelect options={options} value="200000" className="" onChange={onChange} />);
    const select = screen.getByRole('combobox');
    fireEvent.change(select, { target: { value: '100000' } });
    expect(onChange).toHaveBeenLastCalledWith('100000');
    fireEvent.change(select, { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('shows why there is no control, rather than a pretend one', () => {
    render(<ContextWindowSelect options={copilotContextWindowOptions('m', null)} value={undefined} className="" onChange={() => {}} />);
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.getByTestId('context-window-unavailable').textContent).toMatch(/Copilot login/);
  });

  it('shows Loading until the options arrive', () => {
    render(<ContextWindowSelect options={null} value={undefined} className="" onChange={() => {}} />);
    expect(screen.getByText('Loading')).toBeTruthy();
  });
});

describe('copy', () => {
  it('the help says it does not shrink the model, what more costs, and that it waits for the next start', () => {
    const help = contextWindowHelp(claudeContextWindowOptions('opus'))!;
    expect(help).toContain('doesn\'t change the model');
    expect(help).toContain('use more tokens');
    expect(help).toContain('next time the agent starts');
    expect(help).not.toContain('\u2014');
  });

  it('keeps the reported size, compaction point and reserve apart', () => {
    expect(contextSummary({ effectiveTokens: 300000, compactAtTokens: 267000, reservedTokens: 33000 })).toBe('300K, compacts at 267K, 33K in reserve');
    expect(contextSummary(null, 258400)).toBe('258K');
    expect(contextSummary(null)).toBeNull();
  });

  it('formats a saved choice without its catalog', () => {
    expect(formatContextChoice('500000')).toBe('500K');
    expect(formatContextChoice('long_context')).toBe('Long context');
    expect(formatContextChoice('default')).toBe('Standard');
  });
});
