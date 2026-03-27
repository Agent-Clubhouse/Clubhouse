import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { AnnexDisabledView } from './AnnexDisabledView';

describe('AnnexDisabledView', () => {
  it('renders plugin name and not-annex-enabled message', () => {
    render(<AnnexDisabledView pluginName="My Plugin" />);

    expect(screen.getByTestId('annex-disabled-view')).toBeInTheDocument();
    expect(screen.getByText('Not Annex Enabled')).toBeInTheDocument();
    expect(screen.getByText('My Plugin')).toBeInTheDocument();
  });
});
