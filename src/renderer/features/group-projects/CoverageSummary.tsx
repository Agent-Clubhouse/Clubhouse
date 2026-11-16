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

/** What a group project covers, from the main process's read: the same text in the hub, Members and the create preview. */
export function CoverageSummary({ coverage }: { coverage: GroupProjectCoverage | undefined }) {
  const line = coverageLine(coverage);
  if (!coverage?.scoped) return null;
  return (
    <div data-testid="coverage-summary">
      {line && <p className={settingsHelp}>{line}</p>}
      <p className={settingsHelp}>Coverage comes from your project links. A project with the same repository is covered only after you link it.</p>
      <OfferToLink coverage={coverage} />
    </div>
  );
}
