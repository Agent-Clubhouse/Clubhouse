import { useState } from 'react';
import { Button } from '../../components/Button';
import { useGroupProjectStore } from '../../stores/groupProjectStore';
import { ipcErrorMessage } from '../../utils/ipc-error';
import { SettingsBlock, SettingsSection, settingsError, settingsHelp } from '../settings/SettingsLayout';

/**
 * How a group project's members hear about posts (#3362): notices by default,
 * or polling for a group project that still has it on, with an offer to
 * switch. Self-contained: the directory mounts it for the selected record.
 */
export function GroupProjectDeliverySection({ groupProjectId }: { groupProjectId: string }) {
  const project = useGroupProjectStore((s) => s.projects.find((p) => p.id === groupProjectId));
  const setPolling = useGroupProjectStore((s) => s.setPolling);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!project) return null;
  const polling = project.metadata?.pollingEnabled === true;

  const switchToNotices = async () => {
    setBusy(true);
    setError(null);
    try {
      await setPolling(groupProjectId, false);
    } catch (err) {
      // telemetry-exempt: shown inline; polling stays on.
      setError(`Not switched. ${ipcErrorMessage(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection title="New posts">
      <SettingsBlock>
        {polling ? (
          <div className="flex flex-col items-start gap-2">
            <p className={settingsHelp}>
              This group project uses polling, the older way to hear about posts: members check the board
              in a loop, which spends turns while nothing happens. With notices, a member hears about posts
              to its channels as one short message per burst, and a sleeping member isn't woken.
            </p>
            <Button kind="primary" disabled={busy} onClick={() => void switchToNotices()}>
              Switch to notices
            </Button>
            {error && <p role="alert" className={settingsError}>{error}</p>}
          </div>
        ) : (
          <p className={settingsHelp}>
            Members get one notice per burst of posts to their channels: general, control, their inbox,
            channels they subscribe to, and posts that name them. The lead hears about every post.
          </p>
        )}
      </SettingsBlock>
    </SettingsSection>
  );
}
