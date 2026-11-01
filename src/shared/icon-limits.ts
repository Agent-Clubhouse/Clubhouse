/** The longest icon data URL the app accepts, whether from the crop dialog or a file. */
export const ICON_DATA_URL_MAX_LENGTH = 5 * 1024 * 1024;

/** The largest icon file: its bytes must fit that data URL (base64 is 4/3 of the bytes). */
export const ICON_FILE_MAX_BYTES = Math.floor(ICON_DATA_URL_MAX_LENGTH / 4) * 3 - 1024;
