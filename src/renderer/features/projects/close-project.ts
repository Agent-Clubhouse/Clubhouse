import { showConfirmDialog } from '../../plugins/PluginDialog';
import { useProjectStore } from '../../stores/projectStore';
import { useToastStore } from '../../stores/toastStore';

/** Shared Close action: unregister the captured project only. No agent stop or file deletion. */
export async function requestCloseProject(projectId: string, onConfirmed?: () => void): Promise<boolean> {
  const { promise } = showConfirmDialog('Close this project? Project-specific settings may need to be reconfigured.');
  if (!(await promise)) return false;
  onConfirmed?.();
  try {
    await useProjectStore.getState().removeProject(projectId);
    return true;
  } catch {
    // telemetry-exempt: show a fixed error; project paths and raw IPC errors stay private.
    useToastStore.getState().addToast('Could not close the project. Try again.', 'error');
    return false;
  }
}
