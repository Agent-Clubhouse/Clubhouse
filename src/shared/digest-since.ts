/**
 * Validation and wire encoding for the bulletin digest's `since` argument.
 *
 * Shared because the same value crosses three trust boundaries with the same
 * rules: the local IPC bridge (renderer → main), the annex client's REST call
 * (controller → satellite), and the satellite's HTTP handler.
 */

import type { DigestSince } from './group-project-types';

/**
 * Validation bounds, applied at every boundary so a bad caller can't send an
 * unbounded object. Independent of the transport bound below — see there.
 */
export const MAX_SINCE_ENTRIES = 500;
export const MAX_TOPIC_LENGTH = 256;
export const MAX_TIMESTAMP_LENGTH = 64;

/**
 * Transport bound: cap on the encoded query-string value for the per-channel map.
 *
 * Node's HTTP server rejects request lines beyond `--max-http-header-size`
 * (16KB by default), and intermediaries impose their own limits, so the
 * controller degrades to "no cutoff" rather than emitting a request the
 * satellite would reject outright. Well past any realistic board: a 30-channel
 * project encodes to roughly 2KB.
 *
 * Deliberately NOT reconciled with `MAX_SINCE_ENTRIES`: that one bounds what
 * any boundary will validate, this one bounds what a URL can carry. A map can
 * therefore pass validation and still be dropped by the encoder on the remote
 * path while working locally, where nothing is ever encoded into a query
 * string. Raising this to "match" the entry bound would push requests into the
 * 431 range, where the satellite never sees them at all.
 */
export const MAX_SINCE_PARAM_LENGTH = 6000;

/** Keys that must never be copied onto a plain object. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Validate an untrusted `since` value into a `DigestSince`.
 *
 * Accepts a single ISO timestamp string or a `channel -> ISO timestamp` map.
 * Throws on anything else; `label` names the value in the error message so the
 * caller's context (IPC arg position, query param name) survives into the log.
 */
export function parseDigestSince(value: unknown, label: string): DigestSince | undefined {
  if (value === undefined || value === null) return undefined;

  if (typeof value === 'string') {
    if (value.length > MAX_TIMESTAMP_LENGTH) {
      throw new Error(`${label} timestamp must be at most ${MAX_TIMESTAMP_LENGTH} characters`);
    }
    return value;
  }

  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a string or an object`);
  }

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_SINCE_ENTRIES) {
    throw new Error(`${label} must have at most ${MAX_SINCE_ENTRIES} entries`);
  }

  const map: Record<string, string> = {};
  for (const [topic, timestamp] of entries) {
    if (UNSAFE_KEYS.has(topic)) {
      throw new Error(`${label} may not contain the key "${topic}"`);
    }
    if (topic.length > MAX_TOPIC_LENGTH) {
      throw new Error(`${label} topic keys must be at most ${MAX_TOPIC_LENGTH} characters`);
    }
    if (typeof timestamp !== 'string') {
      throw new Error(`${label}.${topic} must be a string`);
    }
    if (timestamp.length > MAX_TIMESTAMP_LENGTH) {
      throw new Error(`${label}.${topic} must be at most ${MAX_TIMESTAMP_LENGTH} characters`);
    }
    map[topic] = timestamp;
  }
  return map;
}

/**
 * Query-param name carrying the per-channel map to a satellite.
 *
 * Deliberately separate from `since` rather than overloading it: a satellite
 * built before this change ignores the unknown param and answers with no
 * cutoff — i.e. the pre-#1555 behaviour of counting everything unread — instead
 * of erroring or misreading a JSON blob as a timestamp. That is the whole
 * version-negotiation story; no handshake is needed.
 */
export const SINCE_CHANNELS_PARAM = 'sinceChannels';

/**
 * Encode a `DigestSince` into query params for the satellite REST call.
 *
 * Returns the params to set. A map that would exceed
 * `MAX_SINCE_PARAM_LENGTH` yields `{ oversized: true }` and no params — the
 * caller should log and send the request without a cutoff.
 */
export function encodeDigestSince(
  since: DigestSince | undefined,
): { params: Record<string, string>; oversized: boolean } {
  if (!since) return { params: {}, oversized: false };
  if (typeof since === 'string') return { params: { since }, oversized: false };

  const keys = Object.keys(since);
  if (keys.length === 0) return { params: {}, oversized: false };

  const encoded = JSON.stringify(since);
  if (encoded.length > MAX_SINCE_PARAM_LENGTH) {
    return { params: {}, oversized: true };
  }
  return { params: { [SINCE_CHANNELS_PARAM]: encoded }, oversized: false };
}

/**
 * Decode the `since` / `sinceChannels` query params a satellite received.
 *
 * `sinceChannels` wins when both are present, so a controller that sends both
 * for compatibility gets the per-channel behaviour. Throws on a malformed
 * value so the handler can answer 400 rather than silently mis-counting.
 */
export function decodeDigestSince(
  since: string | null,
  sinceChannels: string | null,
): DigestSince | undefined {
  if (sinceChannels) {
    if (sinceChannels.length > MAX_SINCE_PARAM_LENGTH) {
      throw new Error(`${SINCE_CHANNELS_PARAM} must be at most ${MAX_SINCE_PARAM_LENGTH} characters`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(sinceChannels);
    } catch {
      throw new Error(`${SINCE_CHANNELS_PARAM} must be valid JSON`);
    }
    if (typeof parsed === 'string') {
      throw new Error(`${SINCE_CHANNELS_PARAM} must be an object`);
    }
    return parseDigestSince(parsed, SINCE_CHANNELS_PARAM);
  }
  return parseDigestSince(since ?? undefined, 'since');
}
