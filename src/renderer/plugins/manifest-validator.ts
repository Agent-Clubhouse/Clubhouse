// Re-export from shared — validateManifest lives in the shared layer so both
// the main process and renderer can use it without a cross-layer import.
export { validateManifest, SUPPORTED_API_VERSIONS } from '../../shared/manifest-validator';
