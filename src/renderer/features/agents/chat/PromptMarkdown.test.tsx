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

  // #3619: a paragraph is a block and a blank line is an empty block with height,
  // so "first\n\nsecond" shows a visible gap instead of "first second".
  describe('block structure', () => {
    const blocks = (text: string) => [...html(text).children].map((el) => `${el.tagName.toLowerCase()}:${el.textContent}`);

    it('keeps a blank paragraph as its own block with a line break to give it height', () => {
      const container = html('first\n\nsecond');
      expect(blocks('first\n\nsecond')).toEqual(['div:first', 'div:', 'div:second']);
      expect(container.children[1].querySelector('br')).not.toBeNull();
      expect(container.textContent).toBe('first\n\nsecond');
    });

    it('keeps several blank paragraphs', () => {
      expect(blocks('a\n\n\nb')).toEqual(['div:a', 'div:', 'div:', 'div:b']);
    });

    it('renders a paragraph followed by a bullet list as distinct blocks', () => {
      expect(blocks('intro\n- a\n- b')).toEqual(['div:intro', 'ul:ab']);
    });

    it('renders a paragraph followed by an ordered list as distinct blocks', () => {
      const container = html('intro\n3. a\n4. b');
      expect([...container.children].map((el) => el.tagName)).toEqual(['DIV', 'OL']);
      expect(container.querySelector('ol')?.getAttribute('start')).toBe('3');
    });

    it('renders a list followed by a paragraph as distinct blocks', () => {
      expect(blocks('- a\n- b\noutro')).toEqual(['ul:ab', 'div:outro']);
    });

    it('keeps a blank paragraph between a list and the text after it', () => {
      expect(blocks('- a\n\noutro')).toEqual(['ul:a', 'div:', 'div:outro']);
    });
  });
});
