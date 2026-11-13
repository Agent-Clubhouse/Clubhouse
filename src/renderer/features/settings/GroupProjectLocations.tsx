import { useEffect, useState } from 'react';
import type { BulletinMessage } from '../../../shared/group-project-types';
import { jumpToConnectionCanvas, lookupConnectionCanvases, type ConnectionCanvasHit } from '../agents/helpers/connection-target-navigation';
import { ipcErrorMessage } from '../../utils/ipc-error';
import { Button } from '../../components/Button';
import { SettingsBlock, SettingsSection, settingsError, settingsHelp } from './SettingsLayout';

/** Read-only board and navigation to each existing representation. */
export function GroupProjectLocations({ id }: { id: string }) {
  const [hits, setHits] = useState<ConnectionCanvasHit[] | null>(null);
  const [messages, setMessages] = useState<BulletinMessage[] | null>(null);
  const [canvasError, setCanvasError] = useState<string | null>(null);
  const [boardError, setBoardError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setHits(null); setMessages(null); setCanvasError(null); setBoardError(null);
    void lookupConnectionCanvases('group-project', id, controller.signal)
      .then((result) => { if (!controller.signal.aborted) setHits(result.hits); })
      .catch((error) => { if (!controller.signal.aborted) setCanvasError(ipcErrorMessage(error)); });
    void window.clubhouse.groupProject.getAllMessages(id)
      .then((result) => { if (!controller.signal.aborted) setMessages(result as BulletinMessage[]); })
      .catch((error) => { if (!controller.signal.aborted) setBoardError(ipcErrorMessage(error)); });
    return () => controller.abort();
  }, [id]);

  const open = async (hit: ConnectionCanvasHit) => {
    if (opening) return;
    setOpening(true); setCanvasError(null);
    try { await jumpToConnectionCanvas('group-project', id, hit, new AbortController().signal); }
    catch (error) { setCanvasError(ipcErrorMessage(error)); }
    finally { setOpening(false); }
  };

  return <>
    <SettingsSection title="Canvases">
      <SettingsBlock>
        {canvasError && <p role="alert" className={settingsError}>{canvasError}</p>}
        {!hits && !canvasError && <p className={settingsHelp}>Loading canvases...</p>}
        {hits?.length === 0 && <p className={settingsHelp}>This group project is not on a canvas.</p>}
        {!!hits?.length && <ul className="flex flex-col items-start gap-2" aria-label="Canvases containing this group project">
          {hits.map((hit) => <li key={`${hit.scope}:${hit.projectId ?? ''}:${hit.canvasId}:${hit.viewId}`}>
            <Button disabled={opening} onClick={() => void open(hit)}>{hit.projectName || 'Home'} / {hit.name}</Button>
          </li>)}
        </ul>}
      </SettingsBlock>
    </SettingsSection>
    <SettingsSection title="Board">
      <SettingsBlock>
        <p className={`${settingsHelp} mb-2`}>Read-only. Open a canvas above to use the board.</p>
        {boardError && <p role="alert" className={settingsError}>{boardError}</p>}
        {!messages && !boardError && <p className={settingsHelp}>Loading board...</p>}
        {messages?.length === 0 && <p className={settingsHelp}>No board messages.</p>}
        {!!messages?.length && <ul aria-label="Board messages" className="flex flex-col gap-3">
          {messages.map((message) => <li key={message.id} className="min-w-0 break-words text-xs text-ctp-text">
            <p className={settingsHelp}>{message.topic} · {message.sender}</p>
            <p className="whitespace-pre-wrap">{message.body}</p>
          </li>)}
        </ul>}
      </SettingsBlock>
    </SettingsSection>
  </>;
}
