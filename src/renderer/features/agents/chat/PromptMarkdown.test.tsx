import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { PromptMarkdown } from './PromptMarkdown';

// Sent messages keep rendering list-looking text as lists; only the composer
// keeps a draft's exact bytes.
describe('PromptMarkdown', () => {
  const html = (text: string) => render(<PromptMarkdown text={text} />).container;

  it('renders repeated numbering as one ordered list', () => {
    expect(html('1. a\n1. b').querySelectorAll('ol > li')).toHaveLength(2);
  });

  it('renders bold inside a list item', () => {
    const container = html('1. **Fix** x\n1. **Test** y');
    expect(container.querySelectorAll('ol > li')).toHaveLength(2);
    expect([...container.querySelectorAll('li strong')].map((node) => node.textContent)).toEqual(['Fix', 'Test']);
  });

  it('renders mixed bullet markers as a list', () => {
    expect(html('- a\n* b').querySelector('ul')).not.toBeNull();
    expect(html('- a\n* b').textContent).not.toContain('*');
  });

  it('renders a continuation line inside its list item', () => {
    const container = html('- first\n  continuation');
    expect(container.querySelectorAll('ul > li')).toHaveLength(1);
    expect(container.querySelector('li')?.textContent).toBe('firstcontinuation');
  });
});
