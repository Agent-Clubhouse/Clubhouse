import { useId, useState } from 'react';
import { postNotificationLabel, postNotificationState, postNotificationsAllowed } from '../../../shared/group-project-notifications';
import { Button } from '../../components/Button';
import { useGroupProjectStore } from '../../stores/groupProjectStore';
import { ipcErrorMessage } from '../../utils/ipc-error';
import { SettingsBlock, SettingsSection, settingsError, settingsHelp } from '../settings/SettingsLayout';
import { GroupOperationStatus, useSectionOperations } from './GroupOperationStatus';

/** One migration action, beside the existing permission. Delivery routes keep a status and a link. */
export function GroupProjectDeliverySection({ groupProjectId, migration = false, onOpenPermissions }: {
  groupProjectId: string;
  migration?: boolean;
  onOpenPermissions?: () => void;
}) {
  const project = useGroupProjectStore((s) => s.projects.find((p) => p.id === groupProjectId));
  const setPolling = useGroupProjectStore((s) => s.setPolling);
  const operations = useSectionOperations(groupProjectId, ['details']);
  const waiting = operations.some((op) => op.op === 'update' && op.outcome.status === 'queued');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const effectId = useId();
  if (!project) return null;
  const legacy = postNotificationState(project) === 'Legacy polling';
  const allowed = postNotificationsAllowed(project);
  const copy = project.network?.role === 'replica';
  const host = project.hostName ?? 'its host';

  const switchToNotices = async () => {
    setBusy(true);
    setError(null);
    try {
      await setPolling(groupProjectId, false);
    } catch (err) {
      // telemetry-exempt: shown inline; the confirmed state stays.
      setError(`Not switched. ${ipcErrorMessage(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection title="Post notifications">
      <SettingsBlock>
        <div className="flex flex-col items-start gap-2">
          <p role="status" aria-label="Post notifications" className="text-sm text-ctp-text">{postNotificationLabel(project)}</p>
          <p className={settingsHelp}>
            {copy ? `This is a copy. ${host} hosts this group project. ${project.network?.state === 'host-removed' ? 'The host left your network, so changes cannot be sent.' : `Changes wait for ${host} to apply them.`}` : 'This computer hosts this group project.'}
            {' '}This is the saved configuration, not confirmation that messages have reached members on other computers.
          </p>
          {legacy ? <p className={settingsHelp}>Members check the board repeatedly, using agent turns even when there are no new posts.</p> : allowed ? (
            <p className={settingsHelp}>
              On this computer, members receive a short message when posts reach their subscribed channels or mention them.
              Members with the Lead role (Allow or Ask first) also receive other members' posts in every channel.
              Sleeping members receive a summary when they next connect. Nearby posts are combined; senders don't receive their own posts.
            </p>
          ) : <p className={settingsHelp}>Turn on “Tell members about new posts” in Permissions to allow post notifications.</p>}
          {legacy && migration && (
            <>
              <p id={effectId} className={settingsHelp}>
                Stops legacy polling and allows short messages about new posts. Sleeping members stay asleep.
                {!allowed && ' Post notifications will remain Off. Turn on “Tell members about new posts” in Permissions to allow them.'}
              </p>
              <Button kind="primary" aria-describedby={effectId} disabled={busy || waiting || project.network?.state === 'host-removed'} onClick={() => void switchToNotices()}>
                Use post notifications
              </Button>
            </>
          )}
          {onOpenPermissions && <Button onClick={onOpenPermissions}>Open Permissions</Button>}
          {busy && <p role="status" className={settingsHelp}>Requesting change...</p>}
          {error && <p role="alert" className={settingsError}>{error}</p>}
          {copy && <GroupOperationStatus groupProjectId={groupProjectId} sections={['details']} label="Changes to this group project" />}
        </div>
      </SettingsBlock>
    </SettingsSection>
  );
}
