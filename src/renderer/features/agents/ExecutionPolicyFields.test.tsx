import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ExecutionPolicyFields } from './ExecutionPolicyFields';

describe('independent sandbox and approval fields', () => {
  it('offers separate axes at Full access without writing on render', () => {
    const onChange = vi.fn();
    render(<ExecutionPolicyFields value={{}} provider="codex-cli" onChange={onChange} />);
    const sandbox = screen.getByLabelText('Sandbox');
    const approval = screen.getByLabelText('Approval policy');
    expect(sandbox).not.toBe(approval);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(sandbox, { target: { value: 'read-only' } });
    expect(onChange).toHaveBeenLastCalledWith({ sandbox: 'read-only' });
    fireEvent.change(approval, { target: { value: 'never' } });
    expect(onChange).toHaveBeenLastCalledWith({ approvalPolicy: 'never' });
  });
  it.each(['claude-code', 'copilot-cli', 'custom'])('disables unsupported %s with a reason', (provider) => {
    render(<ExecutionPolicyFields value={{}} provider={provider} onChange={vi.fn()} />);
    expect((screen.getByLabelText('Sandbox') as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByLabelText('Approval policy') as HTMLSelectElement).disabled).toBe(true);
    expect(screen.getByText(/No verified mapping/, { selector: 'p' })).toBeTruthy();
  });
  it('disables a known unsupported installed Codex version with the reason', () => {
    render(<ExecutionPolicyFields value={{}} provider="codex-cli" version="0.153.4" onChange={vi.fn()} />);
    expect((screen.getByLabelText('Sandbox') as HTMLSelectElement).disabled).toBe(true);
    expect(screen.getByText(/require verified Codex 0.163.0/, { selector: 'p' })).toBeTruthy();
  });
  it('disables unsupported terminal approval, and lets the user explicitly reset a saved override', () => {
    const onChange = vi.fn();
    render(<ExecutionPolicyFields value={{ sandbox: 'read-only' }} provider="codex-cli" runtime="terminal" onChange={onChange} />);
    const approval = screen.getByLabelText('Approval policy') as HTMLSelectElement;
    expect([...approval.options].find((o) => o.value === 'untrusted')?.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Sandbox'), { target: { value: '' } });
    expect(onChange).toHaveBeenCalledWith({ sandbox: null });
  });
});
