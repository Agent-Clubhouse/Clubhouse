import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { MarkdownPreview, splitMermaidSegments } from './MarkdownPreview';

const mermaidParse = vi.fn();
const mermaidRender = vi.fn();

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    parse: (text: string) => mermaidParse(text),
    render: (id: string, text: string) => mermaidRender(id, text),
  },
}));

beforeEach(() => {
  mermaidParse.mockReset();
  mermaidRender.mockReset();
  mermaidParse.mockResolvedValue({});
  mermaidRender.mockResolvedValue({ svg: '<svg data-testid="diagram-svg"></svg>' });
});

describe('MarkdownPreview', () => {
  it('renders markdown content as HTML', () => {
    render(<MarkdownPreview content="# Hello World" />);
    expect(screen.getByText('Hello World')).toBeInTheDocument();
  });

  it('has tabIndex for keyboard focus', () => {
    const { container } = render(<MarkdownPreview content="# Test" />);
    const previewDiv = container.querySelector('.help-content');
    expect(previewDiv).toBeDefined();
    expect(previewDiv!.getAttribute('tabindex')).toBe('0');
  });

  it('is focusable for scoped Cmd+A', () => {
    const { container } = render(<MarkdownPreview content="Some markdown text" />);
    const previewDiv = container.querySelector('.help-content') as HTMLElement;
    previewDiv.focus();
    expect(document.activeElement).toBe(previewDiv);
  });

  it('replaces mermaid code blocks with rendered diagrams', async () => {
    const md = [
      '# Architecture',
      '',
      'Here is the system:',
      '',
      '```mermaid',
      'graph TD; A-->B',
      '```',
      '',
      'And some text after.',
    ].join('\n');

    render(<MarkdownPreview content={md} />);

    // Surrounding markdown still rendered
    expect(screen.getByText('Architecture')).toBeInTheDocument();
    expect(screen.getByText('Here is the system:')).toBeInTheDocument();
    expect(screen.getByText('And some text after.')).toBeInTheDocument();

    // Mermaid block rendered as a diagram, not as a code block
    const diagram = await screen.findByTestId('mermaid-diagram');
    await waitFor(() => expect(diagram.querySelector('svg')).not.toBeNull());

    // The raw mermaid source is no longer in the document
    expect(screen.queryByText('graph TD; A-->B')).toBeNull();
  });

  it('leaves non-mermaid code blocks untouched', () => {
    const md = '```ts\nconst x = 1;\n```';
    const { container } = render(<MarkdownPreview content={md} />);
    expect(container.querySelector('pre')).not.toBeNull();
    expect(container.querySelector('code.language-ts')).not.toBeNull();
  });

  it('handles multiple mermaid blocks', async () => {
    const md = [
      '```mermaid',
      'graph TD; A-->B',
      '```',
      '',
      'Between',
      '',
      '```mermaid',
      'graph TD; C-->D',
      '```',
    ].join('\n');

    render(<MarkdownPreview content={md} />);
    await waitFor(() => {
      expect(screen.getAllByTestId('mermaid-diagram')).toHaveLength(2);
    });
    expect(screen.getByText('Between')).toBeInTheDocument();
  });
});

describe('splitMermaidSegments', () => {
  it('returns one html segment when there are no mermaid blocks', () => {
    const segments = splitMermaidSegments('# Hello');
    expect(segments).toHaveLength(1);
    expect(segments[0].kind).toBe('html');
  });

  it('extracts mermaid blocks as separate segments', () => {
    const md = [
      '# Title',
      '',
      '```mermaid',
      'graph TD; A-->B',
      '```',
      '',
      'After.',
    ].join('\n');
    const segments = splitMermaidSegments(md);
    expect(segments).toHaveLength(3);
    expect(segments[0].kind).toBe('html');
    expect(segments[1]).toEqual({ kind: 'mermaid', code: 'graph TD; A-->B' });
    expect(segments[2].kind).toBe('html');
  });

  it('handles a mermaid-only document', () => {
    const segments = splitMermaidSegments('```mermaid\ngraph TD; A-->B\n```');
    expect(segments).toHaveLength(1);
    expect(segments[0]).toEqual({ kind: 'mermaid', code: 'graph TD; A-->B' });
  });

  it('preserves order across multiple mermaid blocks', () => {
    const md = [
      '```mermaid',
      'one',
      '```',
      '',
      'middle',
      '',
      '```mermaid',
      'two',
      '```',
    ].join('\n');
    const segments = splitMermaidSegments(md);
    expect(segments.map((s) => s.kind)).toEqual(['mermaid', 'html', 'mermaid']);
    expect((segments[0] as { code: string }).code).toBe('one');
    expect((segments[2] as { code: string }).code).toBe('two');
  });
});
