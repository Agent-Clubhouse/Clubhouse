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
    expect(summary).toHaveTextContent('As seen from this computer: covers Atlas.');
    expect(summary).toHaveTextContent(VERIFIED_ON_HOST);
  });

  it('shows nothing for an app-wide group', () => {
    render(<CoverageSummary coverage={{ ...coverage, scoped: false, copies: [] }} remoteHost />);
    expect(screen.queryByTestId('coverage-summary')).not.toBeInTheDocument();
  });
});
