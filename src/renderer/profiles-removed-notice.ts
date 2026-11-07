import { rendererLog } from './plugins/renderer-logger';
import { useToastStore } from './stores/toastStore';

export interface RemovedProfilesNotice {
  profiles: Array<{ name: string; variables: Record<string, string[]> }>;
}

function joinNames(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** The notice's words: profile names and the variable names each set, never values. */
export function removedProfilesMessage(notice: RemovedProfilesNotice): string {
  const described = notice.profiles.map((profile) => {
    const variables = [...new Set(Object.values(profile.variables).flat())].sort();
    return variables.length > 0 ? `${profile.name} (${variables.join(', ')})` : profile.name;
  });
  const which = described.length === 1 ? `The removed profile was ${described[0]}.` : `The removed profiles were ${joinNames(described)}.`;
  return `Provider profiles were removed, so agents now use each CLI's normal signed-in environment. ${which}`;
}

/** Shows the one-time notice when main has one (#2749). Never throws. */
export async function showRemovedProfilesNotice(): Promise<void> {
  try {
    const notice = await window.clubhouse.app.takeRemovedProfilesNotice();
    if (notice && notice.profiles.length > 0) useToastStore.getState().addToast(removedProfilesMessage(notice), 'info');
  } catch (err) {
    rendererLog('core:agent', 'warn', 'Could not read the removed provider profiles notice', {
      meta: { error: err instanceof Error ? err.message : String(err) },
    });
  }
}
