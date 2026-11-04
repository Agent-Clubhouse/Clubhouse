/**
 * PILOT, never ships. The glue between React and the pinned screenshot editor model: one frozen Blob per
 * shot, a model whose life follows the dialog's, and the preview frame the model draws.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { FeedbackSendInput, FeedbackShot } from '../../../shared/feedback-types';
import {
  createScreenshotEditorModel,
  type ScreenshotEditorModel,
  type ScreenshotEditorState,
  type ScreenshotPreview,
  type ScreenshotRaster,
  type ScreenshotSendStarted,
  type ScreenshotWorkerFactory,
} from './pilot-vendor/screenshot-editor.mjs';

/** The model's "as attached" test reads `type`, so a Blob with no type would be re-encoded rather than sent as is. */
export function dataUrlToPngBlob(dataUrl: string): Blob {
  const binary = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: 'image/png' });
}

export interface EditorOptions {
  raster?: ScreenshotRaster;
  limits?: { maxBytes?: number; maxPixels?: number; maxSide?: number };
  workerFactory?: ScreenshotWorkerFactory;
}

const NO_MODEL = (): (() => void) => () => undefined;
const NO_SNAPSHOT = (): null => null;

/**
 * One model for the dialog's life, or null with nothing captured (the model refuses no views).
 *
 * dispose() can't be undone, and StrictMode's simulated unmount runs cleanups, so disposing in a plain
 * cleanup would leave a dead model on the second mount. The dispose waits a task and a remount cancels it.
 */
export function useScreenshotEditorModel(shots: readonly FeedbackShot[], options: EditorOptions = {}, carriedFlattened = false) {
  const [model] = useState<ScreenshotEditorModel | null>(() => (shots.length === 0 ? null : createScreenshotEditorModel({
    views: shots.map((shot, i) => ({ id: shot.shotId || `shot-${i}`, label: shot.label, source: dataUrlToPngBlob(shot.preview), ...(carriedFlattened && { editsAreFinal: true }) })),
    ...options,
  })));
  const pendingDispose = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (pendingDispose.current !== null) clearTimeout(pendingDispose.current);
    pendingDispose.current = null;
    return () => {
      pendingDispose.current = setTimeout(() => model?.dispose(), 0);
    };
  }, [model]);
  const snapshot = useSyncExternalStore<ScreenshotEditorState | null>(model?.subscribe ?? NO_MODEL, model?.getSnapshot ?? NO_SNAPSHOT);
  return { model, snapshot };
}

/**
 * The frame the model draws for the selected view. The key is everything that changes what it shows:
 * imageVersion alone isn't enough, because switching views doesn't move it or close the old frame.
 */
export function useEditorPreview(model: ScreenshotEditorModel | null, snapshot: ScreenshotEditorState | null): ScreenshotPreview | null {
  const [frame, setFrame] = useState<ScreenshotPreview | null>(null);
  const key = snapshot ? `${snapshot.activeView}:${snapshot.status}:${snapshot.imageVersion}` : null;
  useEffect(() => {
    if (!model || key === null) return;
    let live = true;
    let opened: ScreenshotPreview | null = null;
    void model.openPreview().then((next) => {
      if (!live) { next?.close(); return; }
      opened = next;
      setFrame(next);
    }).catch(() => { if (live) setFrame(null); });
    return () => {
      live = false;
      opened?.close();
      setFrame(null);
    };
  }, [model, key]);
  return frame;
}

/** What main's `annotatedPng` takes today. A Uint8Array over IPC would save the base64 step. */
export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/**
 * What a started Send tells main under its rules on origin/main. Nothing here compares bytes. Included always
 * brings its bytes, and main takes its capture's own bytes by hash. Left out: noEdits keeps an unedited capture,
 * and anything else brings its final bytes, a carried flattened image included, since editsAreFinal makes it not original.
 */
export async function sendFields(begun: ScreenshotSendStarted): Promise<Pick<FeedbackSendInput, 'includeScreenshot' | 'annotatedPng' | 'shotId' | 'noEdits'>> {
  const { viewId, bytes, finalBytes, original } = begun;
  const includeScreenshot = bytes !== null;
  // Removed, or a capture that never finished: no flag and no bytes, so main drops what it holds.
  if (viewId === null || finalBytes === null) return { includeScreenshot };
  if (!includeScreenshot && original) return { includeScreenshot, shotId: viewId, noEdits: true };
  return { includeScreenshot, shotId: viewId, annotatedPng: await blobToBase64(finalBytes) };
}
