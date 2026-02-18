import type { PluginModule } from '../../shared/plugin-types';

/** Dynamic import wrapper — in a separate module so tests can mock it. */
export async function dynamicImportModule(url: string): Promise<PluginModule> {
  // Use indirect eval to prevent webpack from analyzing the expression
  const importFn = new Function('path', 'return import(path)') as (path: string) => Promise<PluginModule>;
  return importFn(url);
}
