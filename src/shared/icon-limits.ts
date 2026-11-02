/** The longest icon data URL the app accepts, whether from the crop dialog or a file. */
export const ICON_DATA_URL_MAX_LENGTH = 5 * 1024 * 1024;

/** The largest image file update_agent, update_project and the CLI take. Anything over ICON_STORED_MAX_BYTES is resized. */
export const ICON_SOURCE_MAX_BYTES = 20 * 1024 * 1024;

/** An image file up to this size is stored as it is. */
export const ICON_STORED_MAX_BYTES = 256 * 1024;

/** A larger file is stored as a PNG within a square this many pixels wide, the crop dialog's output size. */
export const ICON_STORED_SIZE = 256;

/** A snapshot's thumbnail fits in a square this many pixels wide. Phones draw avatars far smaller. */
export const ICON_THUMBNAIL_SIZE = 128;

/** An icon file up to this size goes in a snapshot as it is, so a small GIF or WebP keeps its format. */
export const ICON_THUMBNAIL_PASSTHROUGH_BYTES = 64 * 1024;

/**
 * Nor can that file be wider or taller than this. A phone decodes the whole image,
 * so its memory follows pixels rather than bytes, and a small file can hold many.
 */
export const ICON_THUMBNAIL_PASSTHROUGH_SIZE = 256;

/** Clubhouse Go's WebSocket limit (`maximumMessageSize`): a larger frame closes the connection with code 1009. */
export const MOBILE_WS_FRAME_MAX_BYTES = 16 * 1024 * 1024;

/** A snapshot frame above this is sent without icons. The rest of the snapshot can't be left out. */
export const SNAPSHOT_FRAME_MAX_BYTES = 8 * 1024 * 1024;

/** The most icon data one snapshot carries, in data URL characters. Icons past it are left out. */
export const SNAPSHOT_ICONS_MAX_BYTES = 4 * 1024 * 1024;
