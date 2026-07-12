import type { PluginModule } from '../../shared/plugin-types';

/**
 * Perform a genuine native ESM dynamic `import()` of `specifier`.
 *
 * Implemented in plain JavaScript (native-import.js) so ts-loader's commonjs
 * downlevel does not turn the `import()` into a `require()`. See that file's
 * header for the full rationale.
 */
export function nativeDynamicImport(specifier: string): Promise<PluginModule>;
