import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { GroupProjectCoverage } from '../../../shared/group-project-types';
import { CoverageSummary, VERIFIED_ON_HOST } from './CoverageSummary';

const coverage: GroupProjectCoverage = {
  groupProjectId: 'preview', scoped: true, complete: true, localUnknown: false, repositoryMatches: [],
  copies: [{ machine: 'a', projectId: 'p', name: 'Atlas', thisComputer: true, state: 'verified' }],
};

describe('CoverageSummary', () => {
  it('states coverage plainly for a group this computer hosts', () => {
    render(<CoverageSummary coverage={coverage} />);
    expect(screen.getByTestId('coverage-summary')).toHaveTextContent('Covers Atlas.');
    expect(screen.queryByText(VERIFIED_ON_HOST)).not.toBeInTheDocument();
  });

  it('claims no certainty for a remote host: it says what this computer sees and that the host verifies', () => {
    render(<CoverageSummary coverage={coverage} remoteHost />);
    const summary = screen.getByTestId('coverage-summary');
    expect(summary).toHaveTextContent('As seen from this computer, it covers Atlas.');
    expect(summary).toHaveTextContent(VERIFIED_ON_HOST);
  });

  it('says what isn\'t verified once, in plain words, for a remote host', () => {
    const unknown = { machine: 'b', projectId: 'q', name: 'Atlas on Laptop', thisComputer: false, state: 'unknown' as const };
    const { unmount } = render(<CoverageSummary coverage={{ ...coverage, copies: [...coverage.copies, unknown] }} remoteHost />);
    expect(screen.getByTestId('coverage-summary')).toHaveTextContent('As seen from this computer, it covers Atlas. Not verified: Atlas on Laptop.');
    expect(screen.getByTestId('coverage-summary')).not.toHaveTextContent(/on this computer:/);
    unmount();
    render(<CoverageSummary coverage={{ ...coverage, copies: [unknown] }} remoteHost />);
    expect(screen.getByTestId('coverage-summary')).toHaveTextContent('As seen from this computer, not verified: Atlas on Laptop.');
  });

  it('shows nothing for an app-wide group', () => {
    render(<CoverageSummary coverage={{ ...coverage, scoped: false, copies: [] }} remoteHost />);
    expect(screen.queryByTestId('coverage-summary')).not.toBeInTheDocument();
  });
});
