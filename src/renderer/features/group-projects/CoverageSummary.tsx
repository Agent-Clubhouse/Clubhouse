import type { GroupProjectCoverage } from '../../../shared/group-project-types';
import { useUIStore } from '../../stores/uiStore';
import { settingsHelp } from '../settings/SettingsLayout';
import { coverageLine } from './groupProjectsDirectory';

/**
 * Offers a link, and only that: the project settings page has the existing
 * Linked projects section, where the person links the copy themselves. Nothing
 * here links, includes or covers anything.
 */
export function OfferToLink({ coverage, className }: { coverage: GroupProjectCoverage | undefined; className?: string }) {
  const openProjectSettings = useUIStore((s) => s.openProjectSettings);
  if (!coverage?.repositoryMatches.length) return null;
  return (
    <ul aria-label="Projects that match this group's repository" className={className}>
      {coverage.repositoryMatches.map((match) => (
        <li key={match.projectId} className={`${settingsHelp} flex flex-wrap items-center gap-2`}>
          <span>{match.name} has the same repository but is not linked, so it is not covered.</span>
          <button
            type="button"
            data-testid={`offer-to-link-${match.projectId}`}
            aria-label={`Offer to link ${match.name}`}
            className="underline cursor-pointer focus-ring rounded"
            onClick={() => openProjectSettings(match.projectId)}
          >
            Offer to link
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Said under a preview made here for a group another computer will host: only that host can verify its coverage. */
export const VERIFIED_ON_HOST = 'Coverage is verified on the host when the group is created.';

/**
 * What a group project covers, from the main process's read: the same text in the hub, Members and the
 * create preview. `remoteHost` is for a preview made here for a group another computer will host: it
 * says what this computer sees, and that the host verifies coverage itself.
 */
export function CoverageSummary({ coverage, remoteHost = false }: { coverage: GroupProjectCoverage | undefined; remoteHost?: boolean }) {
  const line = coverageLine(coverage);
  if (!coverage?.scoped) return null;
  return (
    <div data-testid="coverage-summary">
      {line && <p className={settingsHelp}>{remoteHost ? `As seen from this computer: ${line.charAt(0).toLowerCase()}${line.slice(1)}` : line}</p>}
      {remoteHost && <p className={settingsHelp}>{VERIFIED_ON_HOST}</p>}
      <OfferToLink coverage={coverage} />
    </div>
  );
}
