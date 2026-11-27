import { FirstRun } from '../../../chrome/pages/FirstRun';
import { useWelcomeTourStore } from '../welcomeTourStore';
import type { SceneDef } from './types';

/**
 * Get started: the empty app's own page, so the two never differ. Adding a
 * project from here opens it, which closes the tour.
 */
function GetStartedStage() {
  return (
    <div className="wt-start">
      <FirstRun embedded onProjectAdded={() => useWelcomeTourStore.getState().closeTour('done')} />
    </div>
  );
}

export const getStarted: SceneDef = {
  title: 'Get started',
  text: 'Add a project and you’re working. Until you do, this is also what the app shows when it’s empty, so you can close the tour and come back to it.',
  Stage: GetStartedStage,
  tall: true,
};
