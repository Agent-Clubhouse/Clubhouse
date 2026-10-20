/**
 * Framebriar feedback telemetry (#2309): capture, submit, delivery, failures with a
 * closed error class, connect and access transitions.
 *
 * Only booleans, counts, states and codes: never notes, screenshots, invitations,
 * error messages or the report id. The report id stays in the local `core:feedback`
 * log so maintainers can match a Framebriar report to the user's log.
 *
 * No OpenTelemetry imports: part of the main bundle.
 */
import { ATTR, FEEDBACK_ACCESS_STATES, getAttributeSpec } from '../../shared/telemetry/attributes';
import { tel } from './facade';

export type FeedbackStage = Parameters<typeof ATTR.feedbackStage>[0];
export type FeedbackErrorClass = Parameters<typeof ATTR.feedbackError>[0];
type AccessState = Parameters<typeof ATTR.feedbackAccessState>[0];
type Notice = Parameters<typeof ATTR.feedbackNotice>[0];
type Refusal = Parameters<typeof ATTR.feedbackRefusal>[0];

const KNOWN_ERRORS = new Set<string>(getAttributeSpec('clubhouse.feedback.error')?.values ?? []);
const ACCESS_STATES = new Set<string>(FEEDBACK_ACCESS_STATES);
/** In-between access states: not reported, only where they settle. */
const TRANSIENT = new Set(['checking', 'connecting', 'disconnecting']);

/** The error's own code when it's registered, else `unknown`. Never the message. */
export function feedbackErrorClass(err: unknown): FeedbackErrorClass {
  const code = (err as { code?: unknown } | null)?.code;
  return (typeof code === 'string' && KNOWN_ERRORS.has(code) ? code : 'unknown') as FeedbackErrorClass;
}

function accessState(state: string): AccessState {
  return (ACCESS_STATES.has(state) ? state : 'other') as AccessState;
}

export function recordFeedbackCaptured(opts: { screenshot: boolean; shots: number; windows: number; trigger: 'button' | 'shortcut' }): void {
  tel.event('clubhouse.feedback.captured', [
    ATTR.feedbackScreenshot(opts.screenshot),
    ATTR.feedbackShots(opts.shots),
    ATTR.feedbackWindows(opts.windows),
    ATTR.feedbackTrigger(opts.trigger),
  ]);
}

export function recordFeedbackSubmitted(opts: { screenshot: boolean; annotated: boolean; shots: number; accessState: string }): void {
  tel.event('clubhouse.feedback.submitted', [
    ATTR.feedbackScreenshot(opts.screenshot),
    ATTR.feedbackAnnotated(opts.annotated),
    ATTR.feedbackShots(opts.shots),
    ATTR.feedbackAccessState(accessState(opts.accessState)),
  ]);
}

export function recordFeedbackDelivered(): void {
  tel.event('clubhouse.feedback.delivered');
}

export function recordFeedbackFailed(stage: FeedbackStage, error: FeedbackErrorClass): void {
  tel.event('clubhouse.feedback.failed', [ATTR.feedbackStage(stage), ATTR.feedbackError(error)]);
}

export function recordFeedbackConnected(): void {
  tel.event('clubhouse.feedback.connected');
}

/** An access transition; in-between states are skipped. */
export function recordFeedbackAccess(from: string | null, state: string, notice: string | null): void {
  if (TRANSIENT.has(state)) return;
  tel.event('clubhouse.feedback.access', [
    ATTR.feedbackAccessState(accessState(state)),
    ATTR.feedbackAccessFrom(from === null ? 'none' : accessState(from)),
    ATTR.feedbackNotice((notice ?? 'none') as Notice),
  ]);
}

export function recordFeedbackRefused(reason: Refusal): void {
  tel.event('clubhouse.feedback.request_refused', [ATTR.feedbackRefusal(reason)]);
}
