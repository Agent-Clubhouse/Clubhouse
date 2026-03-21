import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AnnexUnsupportedPlaceholder } from './AnnexUnsupportedPlaceholder';

describe('AnnexUnsupportedPlaceholder', () => {
  it('renders widget type in the heading', () => {
    render(<AnnexUnsupportedPlaceholder widgetType="Browser" />);
    expect(screen.getByText('Browser unavailable over Annex')).toBeTruthy();
  });

  it('shows default reason when none provided', () => {
    render(<AnnexUnsupportedPlaceholder widgetType="Custom Widget" />);
    expect(screen.getByText('This widget type cannot be viewed over a remote connection.')).toBeTruthy();
  });

  it('shows custom reason when provided', () => {
    render(<AnnexUnsupportedPlaceholder widgetType="Browser" reason="Viewing https://example.com on the satellite." />);
    expect(screen.getByText('Viewing https://example.com on the satellite.')).toBeTruthy();
  });
});
