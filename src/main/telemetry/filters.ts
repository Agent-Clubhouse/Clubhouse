/**
 * Per-destination filters (spec §6.11). Each destination keeps its own level
 * and can add a preset on top. The SDK records at the most verbose enabled
 * level; each destination's filter then decides what it actually receives.
 *
 * No OpenTelemetry imports: used by the SDK chunk and by tests.
 */
import {
  EVENTS,
  METRICS,
  SPANS,
  isKnownEvent,
  isKnownMetric,
  isKnownSpan,
  levelAllows,
  type EventName,
  type SpanName,
  type TelemetryLevel,
} from '../../shared/telemetry/attributes';
import type { TelemetryFilterPreset } from '../../shared/telemetry/settings-types';
import type { DestinationFilter } from './destinations/types';

/** The test event's target destination id (set by sendTestEvent). */
export const TEST_TARGET_KEY = 'clubhouse.telemetry.destination';
const TEST_NAME = 'clubhouse.telemetry.test';

/**
 * "User activity and errors": what a feedback or product-analytics backend
 * needs to put a report in context, without the high-volume diagnostics.
 */
export const USER_ACTIVITY = {
  /** Agent and chat lifecycle, plus permission decisions. Spans that end in error are always kept. */
  spans: new Set<SpanName>([
    'clubhouse.telemetry.test',
    'clubhouse.agent.spawn',
    'clubhouse.agent.kill',
    'clubhouse.agent.create',
    'clubhouse.agent.delete',
    'clubhouse.agent.turn',
    'clubhouse.agent.permission',
  ]),
  /**
   * Feature and navigation events. Every Errors-level event (exceptions,
   * crashes, unclean exits, renderer and process exits, failed actions) is
   * kept as well. There is no separate navigation event today: view and
   * surface changes are recorded as `clubhouse.ui.feature_used`.
   */
  events: new Set<EventName>([
    'clubhouse.telemetry.enabled',
    'clubhouse.telemetry.disabled',
    'clubhouse.ui.feature_used',
    'clubhouse.popout.opened',
    'clubhouse.settings.changed',
    'clubhouse.theme.changed',
    'clubhouse.blueprint.exported',
    'clubhouse.blueprint.imported',
  ]),
  /**
   * Almost no metrics: the session count, so activity can be put per
   * session, and the dropped-items count, so a gap can be told from silence.
   */
  metrics: new Set<string>(['clubhouse.app.sessions', 'clubhouse.telemetry.dropped']),
} as const;

export interface FilterItem {
  name: string;
  attributes: Record<string, unknown>;
  /** Spans only: the span ended with an error status. */
  isError?: boolean;
}

export interface CompiledFilter {
  span(item: FilterItem): boolean;
  log(item: FilterItem): boolean;
  metric(name: string): boolean;
  /** Errors level: forward a trace only if one of its spans ended in error. */
  errorTail: boolean;
}

/** The most verbose level among destinations: what the SDK must record. */
export function recordingLevel(levels: readonly TelemetryLevel[]): TelemetryLevel {
  if (levels.includes('detailed')) return 'detailed';
  if (levels.includes('standard')) return 'standard';
  return 'errors';
}

/** The test event goes only to the destination it names (by id). */
function isOtherTarget(item: FilterItem, destinationId: string): boolean {
  if (item.name !== TEST_NAME) return false;
  const target = item.attributes[TEST_TARGET_KEY];
  return typeof target === 'string' && target !== destinationId;
}

export function compileFilter(filter: DestinationFilter, destinationId: string): CompiledFilter {
  const level = filter.level;
  // At Errors level, flow spans still reach the error tail, which keeps only
  // traces that fail; Detailed spans need Detailed.
  const spanLevel: TelemetryLevel = level === 'errors' ? 'standard' : level;
  const preset: TelemetryFilterPreset = filter.preset;

  return {
    errorTail: level === 'errors',

    span(item) {
      if (!isKnownSpan(item.name) || isOtherTarget(item, destinationId)) return false;
      const def = SPANS[item.name];
      if (!levelAllows(spanLevel, def.level)) return false;
      if (preset === 'user_activity') {
        if (def.level === 'detailed') return false;
        return USER_ACTIVITY.spans.has(item.name) || item.isError === true;
      }
      return true;
    },

    log(item) {
      if (!isKnownEvent(item.name) || isOtherTarget(item, destinationId)) return false;
      const eventLevel = EVENTS[item.name].level;
      if (!levelAllows(level, eventLevel)) return false;
      if (preset === 'user_activity') return eventLevel === 'errors' || USER_ACTIVITY.events.has(item.name);
      return true;
    },

    metric(name) {
      if (!isKnownMetric(name)) return false;
      if (!levelAllows(level, METRICS[name].level)) return false;
      if (preset === 'user_activity') return USER_ACTIVITY.metrics.has(name);
      return true;
    },
  };
}
