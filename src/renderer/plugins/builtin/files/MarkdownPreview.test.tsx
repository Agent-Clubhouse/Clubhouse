import React from 'react';
import { render, screen } from '@testing-library/react';
import { MarkdownPreview } from './MarkdownPreview';

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
});
