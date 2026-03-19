/**
 * URL validation for the browser plugin.
 *
 * Validates URLs against the current protocol settings:
 * - HTTPS: always allowed
 * - HTTP localhost/127.0.0.1: gated by allowLocalhost setting
 * - file://: gated by allowFileProtocol setting
 * - All other protocols: blocked
 */

export interface ProtocolSettings {
  allowLocalhost: boolean;
  allowFileProtocol: boolean;
}

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

const LOCALHOST_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

function isLocalhostHostname(hostname: string): boolean {
  return LOCALHOST_HOSTNAMES.has(hostname);
}

/**
 * Validate a URL against the current protocol settings.
 * Returns { valid: true } or { valid: false, error: "..." } with a user-facing message.
 */
export function validateUrl(url: string, settings: ProtocolSettings): ValidationResult {
  try {
    const parsed = new URL(url);

    if (parsed.protocol === 'https:') {
      return { valid: true };
    }

    if (parsed.protocol === 'http:') {
      if (isLocalhostHostname(parsed.hostname)) {
        if (!settings.allowLocalhost) {
          return {
            valid: false,
            error: 'Localhost URLs are disabled. Enable "Allow localhost" in Browser settings to load http://localhost.',
          };
        }
        return { valid: true };
      }
      // Non-localhost HTTP — block
      return {
        valid: false,
        error: 'Only HTTPS URLs are supported for remote sites. Use https:// instead of http://.',
      };
    }

    if (parsed.protocol === 'file:') {
      if (!settings.allowFileProtocol) {
        return {
          valid: false,
          error: 'File URLs are disabled. Enable "Allow file:// URLs" in Browser settings to load local files.',
        };
      }
      return { valid: true };
    }

    return {
      valid: false,
      error: `Unsupported protocol: ${parsed.protocol} — only https://, http://localhost, and file:// are supported.`,
    };
  } catch {
    return { valid: false, error: 'Invalid URL format.' };
  }
}

/**
 * Normalize a user-entered address into a full URL.
 * - Adds https:// if no protocol is specified (and input doesn't look like file: or localhost)
 * - Adds http:// for localhost/127.0.0.1 without a protocol
 */
export function normalizeAddress(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';

  // Already has a protocol
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    return trimmed;
  }

  // file: without double slash (e.g., "file:/path")
  if (trimmed.startsWith('file:')) {
    return trimmed;
  }

  // Localhost shorthand
  if (/^localhost(:\d+)?($|\/)/.test(trimmed) || /^127\.0\.0\.1(:\d+)?($|\/)/.test(trimmed)) {
    return `http://${trimmed}`;
  }

  // Default to HTTPS
  return `https://${trimmed}`;
}
