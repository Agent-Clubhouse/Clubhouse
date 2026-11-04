import type {FeedbackCopy} from './feedback-copy.d.mts';

export type ScreenshotInkName = 'red'|'yellow'|'blue'|'white';
/** In upright source pixels, top-left origin. Held in memory only: no report or queue type carries one. */
export type ScreenshotMark =
  | {readonly type: 'pen'; readonly points: readonly (readonly [number, number])[]; readonly width: number; readonly ink?: ScreenshotInkName}
  | {readonly type: 'redact'; readonly x: number; readonly y: number; readonly width: number; readonly height: number};

export interface ScreenshotLimits { maxBytes: number; maxPixels: number; maxSide: number }
export const SCREENSHOT_LIMITS: Readonly<ScreenshotLimits>;

/** Frozen, so what was reviewed can't change. Convert a canvas once; a live canvas is refused. */
export type ScreenshotSource = Blob|ImageBitmap;

export interface ScreenshotView {
  id: string;
  label?: string;
  /** A Promise means the capture is frozen and its raster is still finishing. */
  source: ScreenshotSource|Promise<ScreenshotSource>;
}

export interface ScreenshotEditorState {
  /** 'pending' can't be edited, and Send waits. 'failed' is text-only. 'removed' follows remove(). */
  readonly status: 'pending'|'ready'|'failed'|'removed';
  readonly activeView: string|null;
  /** The views left. After the first Send tap, only the selected one. */
  readonly views: readonly {readonly id: string; readonly label: string; readonly status: 'pending'|'ready'|'failed'}[];
  /** Working marks on the selected view. */
  readonly marks: readonly ScreenshotMark[];
  readonly included: boolean;
  /** The image to send differs from the attachment. */
  readonly edited: boolean;
  /** `marks` differ from the last commit. */
  readonly dirty: boolean;
  /** Edits already flattened into the source can't be taken out. */
  readonly editsAreFinal: boolean;
  /** Increases whenever the media a report would carry changes. A new revision needs a new report ID. */
  readonly revision: number;
  readonly canUndo: boolean;
  readonly flattening: boolean;
  /** Moves when a Send tap changes the image marks go on, which is the only thing that does. Open a new preview then. */
  readonly imageVersion: number;
}

/** The selected view, drawn for a host's own UI. It never hands out the source. */
export interface ScreenshotPreview {
  readonly width: number;
  readonly height: number;
  /** False once closed: by you, or by the model when the image changes, is removed or is disposed. */
  readonly open: boolean;
  /** Paints the image at the context's origin, over white. Add the marks with renderMarks. False once closed. */
  draw(context: Pick<CanvasRenderingContext2D,'fillStyle'|'fillRect'|'drawImage'>): boolean;
  close(): void;
}

export interface ScreenshotEditorModel {
  /** Immutable, a new object on each change and stable otherwise, for useSyncExternalStore. */
  getSnapshot(): ScreenshotEditorState;
  subscribe(listener: (state: ScreenshotEditorState) => void): () => void;
  /** False while there's nothing to mark, or for an empty redaction. Throws on a malformed mark. */
  addMark(mark: ScreenshotMark): boolean;
  undo(): void;
  clear(): void;
  /** Whether any view, not just the selected one, holds marks not yet committed. */
  hasUncommittedMarks(): boolean;
  /** Back to the marks in each view's bytes, which is what Cancel does. */
  revert(): void;
  setIncluded(included: boolean): void;
  /** After the first Send tap only one view is left, and the choice can't change. */
  setActiveView(id: string): void;
  /** Drops every source and mark. Off during the save, which is the host's to enforce. */
  remove(): void;
  /**
   * Flattens the marks on every view. On a rejection nothing changes, and `dirty` stays true. Bytes land only
   * if they're still wanted: a revert or the first Send tap during the flatten wins and the call resolves
   * with nothing changed, and a newer mark flattens again before it resolves.
   */
  commit(): Promise<void>;
  /**
   * The PNG to send, or null: left out, removed, or a capture that failed. Encoded once and cached. Commits
   * pending marks first, and answers for the state when it resolves: marks added or a view chosen while it
   * waited are in the answer.
   */
  bytesToSend(): Promise<Blob|null>;
  /** For a local export, which isn't a Send: new flattened bytes, never a source. Doesn't end reversibility. */
  exportBytes(): Promise<Blob|null>;
  /**
   * Draws the selected view for a host's own preview, so it never holds the source. Null with nothing to
   * show. Closed for you when a Send tap changes the image, so a kept preview can't show the original after
   * it: open a new one when `imageVersion` moves.
   */
  openPreview(): Promise<ScreenshotPreview|null>;
  /** On the first Send tap, whether or not the image is included. Throws if any view has uncommitted marks. */
  endReversibility(): void;
  /** Cancels anything in progress: a pending call rejects or resolves to nothing, and no bytes arrive late. */
  dispose(): void;
}

/** What the flattener draws with. The real one is a canvas; Node tests inject their own. */
export interface ScreenshotRaster {
  decode(source: ScreenshotSource): Promise<{width: number; height: number; image: unknown; close?(): void}>;
  surface(width: number, height: number): {
    context: Pick<CanvasRenderingContext2D,'fillStyle'|'strokeStyle'|'lineWidth'|'lineCap'|'lineJoin'|'fillRect'|'beginPath'|'moveTo'|'lineTo'|'stroke'|'arc'|'fill'>;
    image: unknown;
    /** Draws an image scaled to fill this surface. */
    draw(image: unknown): void;
    /** RGBA, top-left origin. */
    read(): Uint8Array|Uint8ClampedArray;
    release(): void;
  };
}

/** Starts a host's worker. Its script is one line: `serveScreenshotWorker(self)`. Any failure falls back to the main thread. */
export type ScreenshotWorkerFactory = () => Pick<Worker,'postMessage'|'terminate'|'onmessage'|'onerror'|'onmessageerror'>;

export function createScreenshotEditorModel(options: {
  views: readonly ScreenshotView[];
  activeView?: string;
  limits?: Partial<ScreenshotLimits>;
  raster?: ScreenshotRaster;
  workerFactory?: ScreenshotWorkerFactory;
}): ScreenshotEditorModel;

/** Pen under redactions whichever came first. Scaled marks and rectangles are clipped to `width` and `height` when given. */
export function renderMarks(context: Pick<CanvasRenderingContext2D,'fillStyle'|'strokeStyle'|'lineWidth'|'lineCap'|'lineJoin'|'fillRect'|'beginPath'|'moveTo'|'lineTo'|'stroke'|'arc'|'fill'>, marks: readonly ScreenshotMark[], options?: {scale?: number; width?: number; height?: number}): void;

/** New opaque PNG bytes with the marks flattened in, or a rejection. Never returns the source. */
export function flattenScreenshot(source: ScreenshotSource, marks?: readonly ScreenshotMark[], options?: {limits?: Partial<ScreenshotLimits>; raster?: ScreenshotRaster; workerFactory?: ScreenshotWorkerFactory; signal?: AbortSignal}): Promise<Blob>;

/** For a host's own worker script. */
export function serveScreenshotWorker(scope: Pick<DedicatedWorkerGlobalScope,'addEventListener'|'postMessage'>): void;

/** On the mounted view's root. A host capturing the DOM skips anything matching the selector. */
export const FEEDBACK_EXCLUDE_ATTRIBUTE: 'data-feedback-capture';
export const FEEDBACK_EXCLUDE_SELECTOR: '[data-feedback-capture="exclude"]';

export interface ScreenshotEditorView {
  destroy(): void;
  /** The element carrying the capture-exclusion attribute. */
  readonly root: HTMLElement;
}

/** Constructable stylesheets and CompressionStream: Chromium 80, Firefox 113, Safari 16.4 and later. */
export function screenshotEditorSupported(windowRef?: typeof globalThis): boolean;

/** A full-window modal rendered inside `container`, normally the host's own dialog. Never portaled out of it. */
export function mountScreenshotEditor(container: Element, options: {
  model: ScreenshotEditorModel;
  copy?: FeedbackCopy;
  /** After the view has closed itself, with new bytes in the model. */
  onDone?: () => void;
  /** After the view has closed itself, with the bytes unchanged. Done with nothing changed lands here too. */
  onCancel?: () => void;
}): ScreenshotEditorView;

export interface ScreenshotCamera { zoom: number; panX: number; panY: number }
export interface ScreenshotSize { width: number; height: number }
export function coveredPixels(rect: {x: number; y: number; width: number; height: number}, options?: {scale?: number; scaleX?: number; scaleY?: number; width?: number; height?: number}): {x: number; y: number; width: number; height: number}|null;
export function penWidth(zoom: number, fittedZoom: number): number;
export function fitDownSize(width: number, height: number, limits?: ScreenshotLimits): ScreenshotSize;
export function encodeOpaquePng(rgba: Uint8ClampedArray|Uint8Array, width: number, height: number, options?: {signal?: AbortSignal}): Promise<Blob>;
export function clampCamera(camera: ScreenshotCamera, image: ScreenshotSize, stage: ScreenshotSize): ScreenshotCamera;
export function fitZoom(image: ScreenshotSize, stage: ScreenshotSize): number;
export function maxZoom(image: ScreenshotSize, stage: ScreenshotSize): number;
export function zoomCamera(camera: ScreenshotCamera, factor: number, atX: number, atY: number, image: ScreenshotSize, stage: ScreenshotSize): ScreenshotCamera;
export function toggleZoom(camera: ScreenshotCamera, atX: number, atY: number, image: ScreenshotSize, stage: ScreenshotSize): ScreenshotCamera;
