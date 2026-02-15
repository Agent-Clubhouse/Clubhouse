import type { PluginManifest } from '../../shared/plugin-types';

export const SUPPORTED_API_VERSIONS = [0.4];

const PLUGIN_ID_REGEX = /^[a-z0-9-]+$/;

interface ValidationResult {
  valid: boolean;
  manifest?: PluginManifest;
  errors: string[];
}

export function validateManifest(raw: unknown): ValidationResult {
  const errors: string[] = [];

  if (!raw || typeof raw !== 'object') {
    return { valid: false, errors: ['Manifest must be a JSON object'] };
  }

  const m = raw as Record<string, unknown>;

  // Required fields
  if (typeof m.id !== 'string' || !m.id) {
    errors.push('Missing required field: id');
  } else if (!PLUGIN_ID_REGEX.test(m.id)) {
    errors.push(`Invalid plugin id "${m.id}": must match /^[a-z0-9-]+$/`);
  }

  if (typeof m.name !== 'string' || !m.name) {
    errors.push('Missing required field: name');
  }

  if (typeof m.version !== 'string' || !m.version) {
    errors.push('Missing required field: version');
  }

  // Engine check
  if (!m.engine || typeof m.engine !== 'object') {
    errors.push('Missing required field: engine');
  } else {
    const engine = m.engine as Record<string, unknown>;
    if (typeof engine.api !== 'number') {
      errors.push('engine.api must be a number');
    } else if (!SUPPORTED_API_VERSIONS.includes(engine.api)) {
      errors.push(`Plugin requires API version ${engine.api}, which is not supported by this version of Clubhouse. Supported API versions: ${SUPPORTED_API_VERSIONS.join(', ')}`);
    }
  }

  // Scope check
  if (m.scope !== 'project' && m.scope !== 'app' && m.scope !== 'dual') {
    errors.push(`Invalid scope: "${String(m.scope)}". Must be "project", "app", or "dual"`);
  }

  // Scope/contributes consistency
  if (m.contributes && typeof m.contributes === 'object') {
    const contrib = m.contributes as Record<string, unknown>;
    if (m.scope === 'project' && contrib.railItem) {
      errors.push('Project-scoped plugins cannot contribute railItem (use tab instead)');
    }
    if (m.scope === 'app' && contrib.tab) {
      errors.push('App-scoped plugins cannot contribute tab (use railItem instead)');
    }
    // Dual-scoped plugins can have both tab and railItem — no restriction
  }

  // v0.4+ requires contributes.help
  const engineObj = m.engine as Record<string, unknown> | undefined;
  const apiVersion = engineObj && typeof engineObj.api === 'number' ? engineObj.api : 0;
  if (apiVersion >= 0.4) {
    const contrib = m.contributes as Record<string, unknown> | undefined;
    if (!contrib || typeof contrib.help !== 'object' || contrib.help === null) {
      errors.push('Plugins targeting API >= 0.4 must include contributes.help');
    } else {
      const help = contrib.help as Record<string, unknown>;
      if (help.topics !== undefined) {
        if (!Array.isArray(help.topics)) {
          errors.push('contributes.help.topics must be an array');
        } else {
          for (let i = 0; i < help.topics.length; i++) {
            const topic = help.topics[i] as Record<string, unknown>;
            if (!topic || typeof topic !== 'object') {
              errors.push(`contributes.help.topics[${i}] must be an object`);
            } else {
              if (typeof topic.id !== 'string' || !topic.id) {
                errors.push(`contributes.help.topics[${i}].id must be a non-empty string`);
              }
              if (typeof topic.title !== 'string' || !topic.title) {
                errors.push(`contributes.help.topics[${i}].title must be a non-empty string`);
              }
              if (typeof topic.content !== 'string' || !topic.content) {
                errors.push(`contributes.help.topics[${i}].content must be a non-empty string`);
              }
            }
          }
        }
      }
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    manifest: raw as PluginManifest,
    errors: [],
  };
}
