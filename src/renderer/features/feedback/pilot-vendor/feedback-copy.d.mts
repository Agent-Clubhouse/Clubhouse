export type RGB = readonly [number, number, number];

/** Mirrors docs/feedback-copy-v1.json, apart from its note. */
export interface FeedbackCopy {
  readonly v: 1;
  readonly inks: Readonly<{default: 'red'; red: RGB; yellow: RGB; blue: RGB; white: RGB}>;
  readonly labels: Readonly<Record<'title'|'includeScreenshot'|'sendLogs'|'move'|'pen'|'redact'|'undo'|'clearEdits'|'cancel'|'done'|'screenshotLeftOut', string>>;
  readonly notes: Readonly<Record<'capturedScreen'|'imageTools'|'screenshotLeftOut'|'edited'|'editedFinal'|'unavailableSecure'|'unavailableFailed'|'emptySend'|'cannotFinish'|'capturePending'|'otherViewMarks'|'cannotPrepare', string>>;
  readonly confirm: Readonly<Record<'clearReversible'|'clearFinal', string>>;
  readonly editorHints: Readonly<Record<'move'|'pen'|'redact', string>>;
  readonly logs: Readonly<Record<'addsExcerpt'|'disabledSettingsOff'|'disabledNotEnrolled'|'disabledUnavailable'|'automaticWhileEnrolled'|'automaticSeparateConsent'|'automaticNone'|'addsLines'|'addsMarker'|'replayUploads'|'replayServerRecords'|'replayOffClears'|'replayOffStops'|'addsLinesSeparate'|'linesLostOnQuit'|'replayDeviceOffClears'|'replayDeviceOffStops'|'automaticSwitch'|'addsExcerptOnly'|'replayServerRecordsOnly'|'markerStill'|'addsMarkerOnly', string>> & {readonly dataClasses: Readonly<Record<LogsDataClass, string>>};
  /** The editor's icon labels, ink names and keyboard hints. */
  readonly editor: Readonly<Record<'screenshot'|'mark'|'marks'|'zoom'|'zoomIn'|'zoomOut'|'zoomFit'|'tools'|'inks'|'views'|'keysMove'|'keysDraw'|'red'|'yellow'|'blue'|'white', string>>;
  readonly status: Readonly<Record<'saving'|'savedSending'|'savedSendingDetail'|'sent'|'sentDetail'|'savedOffline'|'serviceBusy'|'accessRequired'|'heldForEnrollment'|'heldPrompt'|'heldClearPrompt'|'enrollmentChanged'|'rejected'|'storageFull'|'storageUnconfirmed'|'tooLarge'|'enrollmentRejected'|'queueFullHeld'|'queueFullBlocked'|'queueFullWaiting', string>>;
}

export const FEEDBACK_COPY: FeedbackCopy;

/** Fills {action}, {count} and the like. */
export function fillCopy(text: string, values: Readonly<Record<string, string|number>>): string;
/** 'Tap' on touch, 'Click' with a mouse. */
export function actionWord(touch?: boolean): 'Tap'|'Click';

export type LogsDataClass = 'events'|'timings'|'errors'|'ids'|'gameplay'|'sizes'|'crashes'|'app';

/** The host's true facts. A sentence appears only if its fact is true. */
export interface LogsFacts {
  /** What the checkbox controls. 'none' shows no checkbox. */
  attach?: 'excerpt'|'report-lines'|'none';
  /** A checked box would really do what it says on this host now. */
  available?: boolean;
  /** Why not, when `available` is false. 'settings-off' only where Settings really controls it. */
  unavailableReason?: 'settings-off'|'not-enrolled'|'unavailable';
  /** A marker with the report's ID goes to telemetry with the box unchecked. Said with automatic telemetry and a working box, or a box that's `unavailable`. */
  marker?: boolean;
  /** What goes whether or not a report is sent. */
  automatic?: 'none'|'while-enrolled'|'separate-consent';
  /** Must cover what automatic telemetry really contains. Required for 'while-enrolled'. */
  dataClasses?: readonly LogsDataClass[];
  /** Required with 'report-lines' while available. `retention`: a host-supplied sentence, only where the service's behavior is verified. */
  lines?: {delivery: 'in-report'|'separate'; lostOnQuit?: boolean; retention?: string|null}|null;
  /** Null unless replay is active now, not merely because the host is a game. With 'settings-off' only `serverRecords` is said. */
  replay?: {uploads?: boolean; serverRecords?: boolean; offClearsQueue?: boolean}|null;
  /** The tester's current choice, because what the report adds depends on it. Defaults to the checked default. */
  checked?: boolean;
}

export interface LogsControlState {
  shown: boolean;
  enabled: boolean;
  /** Never true while enabled is false. */
  checked: boolean;
  label: string;
  reason: string|null;
  /** In order: what goes automatically, that the switch doesn't change it, what this report adds, the marker, then replay. */
  explanation: readonly string[];
}

/** Throws on an unknown `automatic` fact, missing `dataClasses` or, while available, missing `lines`, which a host's own tests catch. */
export function logsControl(facts?: LogsFacts, copy?: FeedbackCopy): LogsControlState;
