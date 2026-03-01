import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { ToolCard } from './ToolCard';
import type { ToolStart, ToolEnd } from '../../../../shared/structured-events';

const toolStart: ToolStart = {
  id: 't1',
  name: 'Read',
  displayVerb: 'Reading file',
  input: { file_path: 'src/main.ts', offset: 0, limit: 100 },
};

const toolEnd: ToolEnd = {
  id: 't1',
  name: 'Read',
  result: 'ok',
  durationMs: 250,
  status: 'success',
};

describe('ToolCard', () => {
  it('renders the display verb and primary input', () => {
    render(<ToolCard tool={toolStart} output="" status="running" />);
    expect(screen.getByText('Reading file')).toBeInTheDocument();
    expect(screen.getByText('src/main.ts')).toBeInTheDocument();
  });

  it('shows spinner when running', () => {
    const { container } = render(<ToolCard tool={toolStart} output="" status="running" />);
    expect(container.querySelector('.animate-spin')).not.toBeNull();
  });

  it('shows check icon when completed', () => {
    render(<ToolCard tool={toolStart} output="" end={toolEnd} status="completed" />);
    expect(screen.getByText('250ms')).toBeInTheDocument();
  });

  it('shows output when expanded', () => {
    render(<ToolCard tool={toolStart} output="file contents" status="running" />);
    expect(screen.getByTestId('tool-output')).toBeInTheDocument();
    expect(screen.getByText('file contents')).toBeInTheDocument();
  });

  it('shows error styling when status is error', () => {
    const errorEnd: ToolEnd = { ...toolEnd, status: 'error', result: 'File not found' };
    render(<ToolCard tool={toolStart} output="" end={errorEnd} status="error" />);

    const card = screen.getByTestId('tool-card');
    expect(card.dataset.toolStatus).toBe('error');
    expect(screen.getByText('File not found')).toBeInTheDocument();
  });

  it('shows input details when input section is expanded', () => {
    render(<ToolCard tool={toolStart} output="" status="running" />);

    // Click on Input to expand
    fireEvent.click(screen.getByText('Input'));
    expect(screen.getByText(/"file_path": "src\/main.ts"/)).toBeInTheDocument();
  });

  it('displays format duration for seconds', () => {
    const longEnd: ToolEnd = { ...toolEnd, durationMs: 3200 };
    render(<ToolCard tool={toolStart} output="" end={longEnd} status="completed" />);
    expect(screen.getByText('3.2s')).toBeInTheDocument();
  });
});
