import type { PluginManifest } from '../../shared/plugin-types';
import { ALL_PLUGIN_PERMISSIONS } from '../../shared/plugin-types';

export const SUPPORTED_API_VERSIONS = [0.5, 0.6];

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

  // v0.5+ requires contributes.help
  const engineObj = m.engine as Record<string, unknown> | undefined;
  const apiVersion = engineObj && typeof engineObj.api === 'number' ? engineObj.api : 0;
  if (apiVersion >= 0.5) {
    const contrib = m.contributes as Record<string, unknown> | undefined;
    if (!contrib || typeof contrib.help !== 'object' || contrib.help === null) {
      errors.push('Plugins targeting API >= 0.5 must include contributes.help');
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

  // v0.5+ permission validation
  if (apiVersion >= 0.5) {
    if (!Array.isArray(m.permissions)) {
      errors.push('Plugins targeting API >= 0.5 must include a permissions array');
    } else {
      const seen = new Set<string>();
      for (let i = 0; i < m.permissions.length; i++) {
        const perm = m.permissions[i];
        if (typeof perm !== 'string') {
          errors.push(`permissions[${i}] must be a string`);
          continue;
        }
        if (!(ALL_PLUGIN_PERMISSIONS as readonly string[]).includes(perm)) {
          errors.push(`permissions[${i}]: unknown permission "${perm}"`);
          continue;
        }
        if (seen.has(perm)) {
          errors.push(`permissions[${i}]: duplicate permission "${perm}"`);
        }
        seen.add(perm);
      }

      const permissions = m.permissions as string[];
      const hasExternalPerm = permissions.includes('files.external');
      const hasExternalRoots = Array.isArray(m.externalRoots) && m.externalRoots.length > 0;

      if (hasExternalRoots && !hasExternalPerm) {
        errors.push('externalRoots requires the "files.external" permission');
      }
      if (hasExternalPerm && !hasExternalRoots) {
        errors.push('"files.external" permission requires at least one externalRoots entry');
      }

      if (Array.isArray(m.externalRoots)) {
        for (let i = 0; i < m.externalRoots.length; i++) {
          const root = m.externalRoots[i] as Record<string, unknown>;
          if (!root || typeof root !== 'object') {
            errors.push(`externalRoots[${i}] must be an object`);
          } else {
            if (typeof root.settingKey !== 'string' || !root.settingKey) {
              errors.push(`externalRoots[${i}].settingKey must be a non-empty string`);
            }
            if (typeof root.root !== 'string' || !root.root) {
              errors.push(`externalRoots[${i}].root must be a non-empty string`);
            }
          }
        }
      }

      // allowedCommands / process permission validation
      const hasProcessPerm = permissions.includes('process');
      const hasAllowedCommands = Array.isArray(m.allowedCommands) && m.allowedCommands.length > 0;

      if (hasProcessPerm && !hasAllowedCommands) {
        errors.push('"process" permission requires at least one allowedCommands entry');
      }
      if (hasAllowedCommands && !hasProcessPerm) {
        errors.push('allowedCommands requires the "process" permission');
      }

      if (Array.isArray(m.allowedCommands)) {
        for (let i = 0; i < m.allowedCommands.length; i++) {
          const cmd = m.allowedCommands[i];
          if (typeof cmd !== 'string' || !cmd) {
            errors.push(`allowedCommands[${i}] must be a non-empty string`);
          } else if (cmd.includes('/') || cmd.includes('\\') || cmd.includes('..')) {
            errors.push(`allowedCommands[${i}]: "${cmd}" must not contain path separators`);
          }
        }
      }
    }
  }

  // v0.6 specific validation
  if (apiVersion >= 0.5 && Array.isArray(m.permissions)) {
    const permissions = m.permissions as string[];

    // agent-config.permissions and agent-config.mcp require base agent-config permission
    if (permissions.includes('agent-config.permissions') && !permissions.includes('agent-config')) {
      errors.push('"agent-config.permissions" requires the base "agent-config" permission');
    }
    if (permissions.includes('agent-config.mcp') && !permissions.includes('agent-config')) {
      errors.push('"agent-config.mcp" requires the base "agent-config" permission');
    }
  }

  // Validate command declarations with defaultBinding (v0.6+ feature)
  if (m.contributes && typeof m.contributes === 'object') {
    const contrib = m.contributes as Record<string, unknown>;
    if (Array.isArray(contrib.commands)) {
      for (let i = 0; i < contrib.commands.length; i++) {
        const cmd = contrib.commands[i] as Record<string, unknown>;
        if (cmd && typeof cmd === 'object') {
          if (cmd.defaultBinding !== undefined) {
            if (apiVersion < 0.6) {
              errors.push(`contributes.commands[${i}].defaultBinding requires API >= 0.6`);
            } else if (typeof cmd.defaultBinding !== 'string') {
              errors.push(`contributes.commands[${i}].defaultBinding must be a string`);
            }
          }
          if (cmd.global !== undefined && typeof cmd.global !== 'boolean') {
            errors.push(`contributes.commands[${i}].global must be a boolean`);
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
