import { Button } from '../../components/Button';
import { openActionsSettings, useActionsList } from '../actions/useActions';
import { SettingsBlock, SettingsSection, settingsHelp } from '../settings/SettingsLayout';

/** The local host's Actions remain owned by the group even if their creator leaves. */
export function GroupProjectActionsSection({ groupProjectId }: { groupProjectId: string }) {
  const { actions, error, reload } = useActionsList();
  const owned = actions?.filter((action) => action.owner.kind === 'group_project' && action.owner.groupProjectId === groupProjectId) ?? [];
  return <SettingsSection title="Actions"><SettingsBlock>
    {error && <p role="alert" className={settingsHelp}>Could not load Actions. <Button onClick={reload}>Retry</Button></p>}
    {!actions && !error && <p className={settingsHelp}>Loading Actions...</p>}
    {actions && owned.length === 0 && <p className={settingsHelp}>No Actions yet.</p>}
    {owned.length > 0 && <ul aria-label="Group project Actions">{owned.map((action) => <li key={action.id}>
      <button className="text-xs text-ctp-text hover:underline" onClick={() => openActionsSettings({ cardId: action.id })}>{action.name}</button>
    </li>)}</ul>}
    <Button className="mt-2" onClick={() => openActionsSettings({ groupProjectId })}>New action</Button>
  </SettingsBlock></SettingsSection>;
}
