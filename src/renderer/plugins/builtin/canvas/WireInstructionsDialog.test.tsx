import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { WireInstructionsDialog } from './WireInstructionsDialog';
import type { McpBindingEntry } from '../../../stores/mcpBindingStore';

describe('WireInstructionsDialog', () => {
  const agentBinding: McpBindingEntry = {
    agentId: 'agent-1',
    targetId: 'agent-2',
    targetKind: 'agent',
    label: 'Agent 2',
  };

  it('renders with All Tools selected by default', () => {
    const { getByTestId } = render(
      <WireInstructionsDialog binding={agentBinding} onSave={vi.fn()} onClose={vi.fn()} />,
    );
    const select = getByTestId('wire-instructions-tool-select') as HTMLSelectElement;
    expect(select.value).toBe('*');
  });

  it('shows tool options for agent target kind', () => {
    const { getByTestId } = render(
      <WireInstructionsDialog binding={agentBinding} onSave={vi.fn()} onClose={vi.fn()} />,
    );
    const select = getByTestId('wire-instructions-tool-select') as HTMLSelectElement;
    const options = Array.from(select.options).map((o) => o.value);
    expect(options).toContain('*');
    expect(options).toContain('send_message');
    expect(options).toContain('read_output');
    expect(options).toContain('get_status');
    expect(options).toContain('check_connectivity');
  });

  it('shows browser tool options for browser target kind', () => {
    const browserBinding: McpBindingEntry = {
      agentId: 'agent-1',
      targetId: 'browser-1',
      targetKind: 'browser',
      label: 'Browser',
    };
    const { getByTestId } = render(
      <WireInstructionsDialog binding={browserBinding} onSave={vi.fn()} onClose={vi.fn()} />,
    );
    const select = getByTestId('wire-instructions-tool-select') as HTMLSelectElement;
    const options = Array.from(select.options).map((o) => o.value);
    expect(options).toContain('navigate');
    expect(options).toContain('screenshot');
  });

  it('initializes textarea from existing instructions', () => {
    const bindingWithInstructions: McpBindingEntry = {
      ...agentBinding,
      instructions: { '*': 'Do not share secrets' },
    };
    const { getByTestId } = render(
      <WireInstructionsDialog binding={bindingWithInstructions} onSave={vi.fn()} onClose={vi.fn()} />,
    );
    const textarea = getByTestId('wire-instructions-textarea') as HTMLTextAreaElement;
    expect(textarea.value).toBe('Do not share secrets');
  });

  it('calls onSave with instructions when Save is clicked', () => {
    const onSave = vi.fn();
    const { getByTestId } = render(
      <WireInstructionsDialog binding={agentBinding} onSave={onSave} onClose={vi.fn()} />,
    );
    const textarea = getByTestId('wire-instructions-textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'No raw telemetry' } });
    fireEvent.click(getByTestId('wire-instructions-save'));
    expect(onSave).toHaveBeenCalledWith({ '*': 'No raw telemetry' });
  });

  it('cleans empty instructions on save', () => {
    const onSave = vi.fn();
    const bindingWithInstructions: McpBindingEntry = {
      ...agentBinding,
      instructions: { '*': 'Old instruction' },
    };
    const { getByTestId } = render(
      <WireInstructionsDialog binding={bindingWithInstructions} onSave={onSave} onClose={vi.fn()} />,
    );
    const textarea = getByTestId('wire-instructions-textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '' } });
    fireEvent.click(getByTestId('wire-instructions-save'));
    expect(onSave).toHaveBeenCalledWith({});
  });

  it('calls onClose when Cancel is clicked', () => {
    const onClose = vi.fn();
    const { getByTestId } = render(
      <WireInstructionsDialog binding={agentBinding} onSave={vi.fn()} onClose={onClose} />,
    );
    fireEvent.click(getByTestId('wire-instructions-cancel'));
    expect(onClose).toHaveBeenCalled();
  });

  it('calls onClose when backdrop is clicked', () => {
    const onClose = vi.fn();
    const { getByTestId } = render(
      <WireInstructionsDialog binding={agentBinding} onSave={vi.fn()} onClose={onClose} />,
    );
    fireEvent.click(getByTestId('wire-instructions-dialog'));
    expect(onClose).toHaveBeenCalled();
  });

  it('switches between tools and preserves per-tool drafts', () => {
    const { getByTestId } = render(
      <WireInstructionsDialog binding={agentBinding} onSave={vi.fn()} onClose={vi.fn()} />,
    );
    const textarea = getByTestId('wire-instructions-textarea') as HTMLTextAreaElement;
    const select = getByTestId('wire-instructions-tool-select') as HTMLSelectElement;

    // Type into All Tools
    fireEvent.change(textarea, { target: { value: 'Global instruction' } });

    // Switch to send_message
    fireEvent.change(select, { target: { value: 'send_message' } });
    expect(textarea.value).toBe('');

    // Type into send_message
    fireEvent.change(textarea, { target: { value: 'Message-specific instruction' } });

    // Switch back to All Tools — global instruction preserved
    fireEvent.change(select, { target: { value: '*' } });
    expect(textarea.value).toBe('Global instruction');
  });
});
