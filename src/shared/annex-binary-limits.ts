/** Existing /ws clipboard limit, measured as base64 characters (7.5 MiB raw). */
export const CLIPBOARD_IMAGE_MAX_BASE64 = 10 * 1024 * 1024;
/** Existing rich-content limit, measured before base64 encoding. */
export const MOBILE_CONTENT_MAX_BYTES = 8 * 1024 * 1024;
/** JSON content also contains bounded metadata around this base64 field. */
export const MOBILE_CONTENT_MAX_BASE64 = 4 * Math.ceil(MOBILE_CONTENT_MAX_BYTES / 3);
