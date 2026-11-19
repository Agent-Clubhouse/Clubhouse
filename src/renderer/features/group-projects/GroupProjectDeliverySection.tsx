import { postNotificationLabel, postNotificationsAllowed } from '../../../shared/group-project-notifications';
import { Button } from '../../components/Button';
import { useGroupProjectStore } from '../../stores/groupProjectStore';
import { SettingsBlock, SettingsSection, settingsHelp } from '../settings/SettingsLayout';
import { GroupOperationStatus } from './GroupOperationStatus';

/** Delivery status beside the existing permission. Delivery routes keep a status and a link. */
export function GroupProjectDeliverySection({ groupProjectId, onOpenPermissions }: {
  groupProjectId: string;
  onOpenPermissions?: () => void;
}) {
  const project = useGroupProjectStore((s) => s.projects.find((p) => p.id === groupProjectId));
  if (!project) return null;
  const allowed = postNotificationsAllowed(project);
  const copy = project.network?.role === 'replica';
  const host = project.hostName ?? 'its host';

  return (
    <SettingsSection title="Post notifications">
      <SettingsBlock>
        <div className="flex flex-col items-start gap-2">
          <p role="status" aria-label="Post notifications" className="text-sm text-ctp-text">{postNotificationLabel(project)}</p>
          <p className={settingsHelp}>
            {copy ? `This is a copy. ${host} hosts this group project. ${project.network?.state === 'host-removed' ? 'The host left your network, so changes cannot be sent.' : `Changes wait for ${host} to apply them.`}` : 'This computer hosts this group project.'}
            {' '}This is the saved configuration, not confirmation that messages have reached members on other computers.
          </p>
          {allowed ? (
            <p className={settingsHelp}>
              On this computer, members receive a short message when posts reach their subscribed channels or mention them.
              Members with the Lead role (Allow or Ask first) also receive other members' posts in every channel.
              Sleeping members receive a summary when they next connect. Nearby posts are combined; senders don't receive their own posts.
            </p>
          ) : <p className={settingsHelp}>Turn on “Tell members about new posts” in Permissions to allow post notifications.</p>}
          {onOpenPermissions && <Button onClick={onOpenPermissions}>Open Permissions</Button>}
          {copy && <GroupOperationStatus groupProjectId={groupProjectId} sections={['details']} label="Changes to this group project" />}
        </div>
      </SettingsBlock>
    </SettingsSection>
  );
}
