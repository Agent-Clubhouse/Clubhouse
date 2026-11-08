import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { claudeContextWindowOptions, copilotContextWindowOptions } from '../../../shared/context-window';
import { ContextWindowSelect, contextSummary, contextWindowHelp, formatContextChoice, nowAndNextStart, pendingContextChoice, sessionModelLine } from './ContextWindowField';

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

describe('now and next start (#2790)', () => {
  it('puts a waiting choice after what runs now, and says only one when that is all there is', () => {
    expect(nowAndNextStart('300K, compacts at 267K', '500K')).toBe('300K, compacts at 267K. Next start: 500K');
    expect(nowAndNextStart('300K', null)).toBe('300K');
    expect(nowAndNextStart(null, '500K')).toBe('Next start: 500K');
    expect(nowAndNextStart('500K', '500K')).toBe('500K');
    expect(nowAndNextStart(null, null)).toBeNull();
  });

  it('names the next start\'s model only when the session moved off the model it started on', () => {
    expect(sessionModelLine({ model: 'opus', startModel: 'sonnet' }, 'Opus 5.5', 'Sonnet 5.5')).toBe('Opus 5.5. Next start: Sonnet 5.5');
    expect(sessionModelLine({ model: 'opus', startModel: 'sonnet' }, 'Opus 5.5', 'Default model')).toBe('Opus 5.5. Next start: Default model');
    // Started on it: a saved full id and the session's alias for it say nothing.
    expect(sessionModelLine({ model: 'opus', startModel: 'opus' }, 'Opus 5.5', 'claude-opus-5-5')).toBeNull();
    expect(sessionModelLine({ model: 'opus', startModel: null }, 'Opus 5.5', 'Sonnet 5.5')).toBeNull();
    expect(sessionModelLine(undefined, 'Opus 5.5', 'Sonnet 5.5')).toBeNull();
  });

  it('treats a saved size the session already runs at as nothing waiting', () => {
    expect(pendingContextChoice('300000', { effectiveTokens: 300000, compactAtTokens: 267000, reservedTokens: 33000 })).toBeNull();
    expect(pendingContextChoice('500000', { effectiveTokens: 300000, compactAtTokens: null, reservedTokens: null })).toBe('500K');
    expect(pendingContextChoice('500000', null)).toBe('500K');
    expect(pendingContextChoice(undefined, null)).toBeNull();
  });
});
