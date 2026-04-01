import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { EmojiPicker } from './EmojiPicker';

describe('EmojiPicker', () => {
  it('renders with search input and category tabs', () => {
    render(<EmojiPicker onSelect={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByPlaceholderText('Search emoji...')).toBeInTheDocument();
    // Category labels visible
    expect(screen.getByText('Smileys')).toBeInTheDocument();
    expect(screen.getByText('Animals')).toBeInTheDocument();
    expect(screen.getByText('Objects')).toBeInTheDocument();
  });

  it('calls onSelect with the emoji when clicked', () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(<EmojiPicker onSelect={onSelect} onClose={onClose} />);

    // Find and click the rocket emoji
    const rocketButton = screen.getByTitle('rocket');
    fireEvent.click(rocketButton);

    expect(onSelect).toHaveBeenCalledWith('\u{1F680}');
    expect(onClose).toHaveBeenCalled();
  });

  it('filters emojis by search query', () => {
    render(<EmojiPicker onSelect={vi.fn()} onClose={vi.fn()} />);
    const searchInput = screen.getByPlaceholderText('Search emoji...');

    fireEvent.change(searchInput, { target: { value: 'rocket' } });

    // Should show rocket emoji
    expect(screen.getByTitle('rocket')).toBeInTheDocument();
    // Category headers should not be visible during search
    expect(screen.queryByText('Smileys')).not.toBeInTheDocument();
  });

  it('shows no results message for empty search', () => {
    render(<EmojiPicker onSelect={vi.fn()} onClose={vi.fn()} />);
    const searchInput = screen.getByPlaceholderText('Search emoji...');

    fireEvent.change(searchInput, { target: { value: 'zzzzzznotanemoji' } });

    expect(screen.getByText('No results')).toBeInTheDocument();
  });

  it('closes on Escape key', () => {
    const onClose = vi.fn();
    render(<EmojiPicker onSelect={vi.fn()} onClose={onClose} />);

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).toHaveBeenCalled();
  });

  it('focuses search input on mount', () => {
    render(<EmojiPicker onSelect={vi.fn()} onClose={vi.fn()} />);
    const searchInput = screen.getByPlaceholderText('Search emoji...');
    expect(document.activeElement).toBe(searchInput);
  });

  it('shows multiple results for partial search', () => {
    render(<EmojiPicker onSelect={vi.fn()} onClose={vi.fn()} />);
    const searchInput = screen.getByPlaceholderText('Search emoji...');

    fireEvent.change(searchInput, { target: { value: 'heart' } });

    // Should find multiple heart emojis
    const buttons = screen.getAllByRole('button');
    const heartButtons = buttons.filter((b) => b.getAttribute('title')?.includes('heart'));
    expect(heartButtons.length).toBeGreaterThan(1);
  });
});
