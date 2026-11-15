import { useEffect, useState } from 'react';
import { jumpToConnectionCanvas, lookupConnectionCanvases, type ConnectionCanvasHit } from '../agents/helpers/connection-target-navigation';
import { ipcErrorMessage } from '../../utils/ipc-error';
import { Button } from '../../components/Button';
import { SettingsBlock, SettingsSection, settingsError, settingsHelp } from './SettingsLayout';

/**
 * Each canvas that holds this group project, and a way to open it. A canvas is optional:
 * the board and everything else work without one.
 */
export function GroupProjectLocations({ id }: { id: string }) {
  const [hits, setHits] = useState<ConnectionCanvasHit[] | null>(null);
  const [canvasError, setCanvasError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setHits(null); setCanvasError(null);
    void lookupConnectionCanvases('group-project', id, controller.signal)
      .then((result) => { if (!controller.signal.aborted) setHits(result.hits); })
      .catch((error) => { if (!controller.signal.aborted) setCanvasError(ipcErrorMessage(error)); });
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
        {hits?.length === 0 && <p className={settingsHelp}>This group project is not on a canvas. It works without one.</p>}
        {!!hits?.length && <ul className="flex flex-col items-start gap-2" aria-label="Canvases containing this group project">
          {hits.map((hit) => <li key={`${hit.scope}:${hit.projectId ?? ''}:${hit.canvasId}:${hit.viewId}`}>
            <Button disabled={opening} onClick={() => void open(hit)}>{hit.projectName || 'Home'} / {hit.name}</Button>
          </li>)}
        </ul>}
        <p className={`${settingsHelp} mt-2`}>Removing a canvas card keeps this group project and its members.</p>
      </SettingsBlock>
    </SettingsSection>
  </>;
}
