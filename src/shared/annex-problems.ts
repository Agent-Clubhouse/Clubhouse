/**
 * Annex connection problems (#3057): each one says what happened and what to do.
 *
 * The client classifies a raw error (a Node socket code, an HTTP refusal, a TLS
 * failure) into one of these codes once, and every surface (the device list,
 * the pairing wizard, a satellite's `lastError`) shows the same two sentences.
 */

export type AnnexProblemCode =
  | 'refused'
  | 'timeout'
  | 'unreachable'
  | 'not-found'
  | 'dropped'
  | 'stopped-answering'
  | 'incompatible'
  | 'wrong-role'
  | 'tls-unavailable'
  | 'http-refused'
  | 'old-pairing'
  | 'removed-there'
  | 'cert-expired'
  | 'cert-not-yet-valid'
  | 'cert-mismatch'
  | 'not-found-yet'
  | 'client-off'
  | 'connection-failed';

export interface AnnexProblem {
  code: AnnexProblemCode;
  /** What happened, as a sentence. */
  message: string;
  /** What to do about it, as a sentence. */
  action: string;
}

/** Problems a live connection retries by itself. While pairing nothing retries, so they say to try again. */
const PAIRING_ACTIONS: Partial<Record<AnnexProblemCode, string>> = {
  unreachable: "Check this computer's network connection, then try again.",
  dropped: 'Try again.',
  'stopped-answering': 'Check that it is awake, then try again.',
  'cert-mismatch': "The computer at that address isn't the one you meant. Check the link or code, then try again.",
  'connection-failed': 'Check that Annex is on there, then try again.',
  'http-refused': 'Try again.',
};

/**
 * The two sentences for a problem with the device called `alias`. With
 * `pairing`, the advice suits a pairing attempt, which never retries by itself.
 */
export function describeAnnexProblem(
  code: AnnexProblemCode,
  alias: string,
  detail?: { status?: number; pairing?: boolean },
): AnnexProblem {
  const name = alias || 'That computer';
  const text = ((): [string, string] => {
    switch (code) {
      case 'refused':
        return [`${name} isn't accepting connections.`, 'Check that Clubhouse is open there with Annex turned on.'];
      case 'timeout':
        return [`${name} didn't answer in time.`, 'Check that it is awake and on the same network or tailnet.'];
      case 'unreachable':
        return [`This computer can't reach ${name} at its last address.`, "Check this computer's network connection. Clubhouse tries again when it's back."];
      case 'not-found':
        return [`Couldn't find ${name} by its address.`, 'Check the address, or connect both computers to the same network.'];
      case 'dropped':
        return [`The connection to ${name} dropped.`, 'Clubhouse is reconnecting.'];
      case 'stopped-answering':
        return [`${name} stopped answering.`, 'Clubhouse is reconnecting. If it went to sleep, wake it.'];
      case 'incompatible':
        return [`${name} runs a version of Clubhouse that can't connect to this one.`, 'Update Clubhouse on both computers.'];
      case 'wrong-role':
        return [`${name} has this computer listed as one it controls.`, 'Pair again from this computer to control it.'];
      case 'tls-unavailable':
        return [`${name} couldn't start its secure connection.`, 'Turn Annex off and on there, then retry.'];
      case 'http-refused':
        return [`${name} refused the connection${detail?.status ? ` (HTTP ${detail.status})` : ''}.`, 'Reconnect. If it keeps happening, pair again.'];
      case 'old-pairing':
        return ['This pairing is from an older version of Clubhouse.', 'Pair again to connect.'];
      case 'removed-there':
        return [`This computer is no longer paired on ${name}.`, 'Pair again to connect.'];
      case 'cert-expired':
        return [`${name}'s certificate has expired.`, 'Pair again to connect.'];
      case 'cert-not-yet-valid':
        return [`${name}'s certificate isn't valid yet.`, 'Check the date and time on both computers, then retry.'];
      case 'cert-mismatch':
        return [`${name} showed a different certificate.`, 'If it was reset, pair again.'];
      case 'not-found-yet':
        return [`${name} hasn't been found on the network yet.`, 'Check that Clubhouse is open there with Annex turned on.'];
      case 'client-off':
        return ['Connecting to other computers is turned off here.', 'Turn on Annex Network in Settings.'];
      case 'connection-failed':
        return [`Couldn't connect to ${name}.`, 'Reconnect. If it keeps failing, check that Annex Network is on there.'];
    }
  })();
  const action = (detail?.pairing && PAIRING_ACTIONS[code]) || text[1];
  return { code, message: text[0], action };
}

/** Both sentences as one line, for places that show a single string. */
export function annexProblemText(problem: AnnexProblem): string {
  return `${problem.message} ${problem.action}`;
}

/** Socket error codes and the problem each means. */
const SOCKET_CODES: Record<string, AnnexProblemCode> = {
  ECONNREFUSED: 'refused',
  ETIMEDOUT: 'timeout',
  ESOCKETTIMEDOUT: 'timeout',
  EHOSTUNREACH: 'unreachable',
  ENETUNREACH: 'unreachable',
  ENETDOWN: 'unreachable',
  EHOSTDOWN: 'unreachable',
  EADDRNOTAVAIL: 'unreachable',
  ENOTFOUND: 'not-found',
  EAI_AGAIN: 'not-found',
  EAI_NONAME: 'not-found',
  ECONNRESET: 'dropped',
  EPIPE: 'dropped',
  ECONNABORTED: 'dropped',
  CERT_HAS_EXPIRED: 'cert-expired',
  CERT_NOT_YET_VALID: 'cert-not-yet-valid',
  // A certificate other than the pinned or expected one.
  ERR_ANNEX_PIN_MISMATCH: 'cert-mismatch',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'cert-mismatch',
  SELF_SIGNED_CERT_IN_CHAIN: 'cert-mismatch',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'cert-mismatch',
  ERR_TLS_CERT_ALTNAME_INVALID: 'cert-mismatch',
};

/**
 * The problem a raw connection error means. Reads a Node error's `code` first,
 * then looks for the code or a known phrase in its message.
 */
export function classifyConnectionError(err: unknown): AnnexProblemCode {
  const code = typeof err === 'object' && err !== null && 'code' in err ? String((err as { code?: unknown }).code ?? '') : '';
  if (code && SOCKET_CODES[code]) return SOCKET_CODES[code];
  const text = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  for (const [socketCode, problem] of Object.entries(SOCKET_CODES)) {
    if (text.includes(socketCode)) return problem;
  }
  if (/heartbeat/i.test(text)) return 'stopped-answering';
  if (/timed? ?out/i.test(text)) return 'timeout';
  if (/socket hang up|connection closed/i.test(text)) return 'dropped';
  if (/incompatible/i.test(text)) return 'incompatible';
  return 'connection-failed';
}

/** The problem an HTTP refusal (REST or the WebSocket upgrade) means. */
export function classifyRefusal(status: number, error: unknown): AnnexProblemCode {
  if (error === 'needs_pairing') return 'old-pairing';
  if (error === 'peer_not_paired') return 'removed-there';
  if (error === 'peer_role_not_allowed') return 'wrong-role';
  if (error === 'tls_unavailable' || status === 503) return 'tls-unavailable';
  return 'http-refused';
}
