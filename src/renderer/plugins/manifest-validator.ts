import type { PluginManifest } from '../../shared/plugin-types';
import { ALL_PLUGIN_PERMISSIONS, PERMISSION_HIERARCHY } from '../../shared/plugin-types';
import { SUPPORTED_PLUGIN_API_VERSIONS } from '../../shared/marketplace-types';

/** @deprecated Use SUPPORTED_PLUGIN_API_VERSIONS from shared/marketplace-types instead. */
export const SUPPORTED_API_VERSIONS = SUPPORTED_PLUGIN_API_VERSIONS;

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

  // Kind validation (v0.7+)
  const engineObj = m.engine as Record<string, unknown> | undefined;
  const apiVersion = engineObj && typeof engineObj.api === 'number' ? engineObj.api : 0;
  const isPack = m.kind === 'pack';

  if (m.kind !== undefined) {
    if (m.kind !== 'plugin' && m.kind !== 'pack') {
      errors.push(`Invalid kind: "${String(m.kind)}". Must be "plugin" or "pack"`);
    }
    if (isPack && apiVersion < 0.7) {
      errors.push('Pack plugins require API >= 0.7');
    }
  }

  // Pack-specific validation
  if (isPack) {
    if (m.main !== undefined) {
      errors.push('Pack plugins must not specify a "main" entry');
    }
    if (m.settingsPanel !== undefined) {
      errors.push('Pack plugins must not specify a "settingsPanel"');
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
    // Pack plugins must not have UI contributions
    if (isPack) {
      if (contrib.tab) {
        errors.push('Pack plugins cannot contribute a tab');
      }
      if (contrib.railItem) {
        errors.push('Pack plugins cannot contribute a railItem');
      }
      if (contrib.globalDialog) {
        errors.push('Pack plugins cannot contribute a globalDialog');
      }
    }
    // Dual-scoped plugins can have both tab and railItem — no restriction
  }

  // v0.5+ requires contributes.help (packs get a pass — help is optional for packs)
  if (apiVersion >= 0.5 && !isPack) {
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

  // v0.5+ permission validation (packs don't require permissions array)
  if (apiVersion >= 0.5 && !isPack) {
    if (!Array.isArray(m.permissions)) {
      errors.push('Plugins targeting API >= 0.5 must include a permissions array');
    }
  }

  // Validate permission entries if present (for both plugins and packs)
  if (Array.isArray(m.permissions)) {
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

    // Enforce parent-child permission hierarchy from PERMISSION_HIERARCHY
    for (const [child, parent] of Object.entries(PERMISSION_HIERARCHY)) {
      if (permissions.includes(child) && !permissions.includes(parent)) {
        errors.push(`"${child}" requires the base "${parent}" permission`);
      }
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

    // v0.7+ contributes.themes validation
    if (contrib.themes !== undefined) {
      if (apiVersion < 0.7) {
        errors.push('contributes.themes requires API >= 0.7');
      } else if (!Array.isArray(contrib.themes)) {
        errors.push('contributes.themes must be an array');
      } else {
        for (let i = 0; i < contrib.themes.length; i++) {
          const theme = contrib.themes[i] as Record<string, unknown>;
          if (!theme || typeof theme !== 'object') {
            errors.push(`contributes.themes[${i}] must be an object`);
          } else {
            if (typeof theme.id !== 'string' || !theme.id) {
              errors.push(`contributes.themes[${i}].id must be a non-empty string`);
            }
            if (typeof theme.name !== 'string' || !theme.name) {
              errors.push(`contributes.themes[${i}].name must be a non-empty string`);
            }
            if (theme.type !== 'dark' && theme.type !== 'light') {
              errors.push(`contributes.themes[${i}].type must be "dark" or "light"`);
            }
            if (!theme.colors || typeof theme.colors !== 'object') {
              errors.push(`contributes.themes[${i}].colors must be an object`);
            }
            if (!theme.hljs || typeof theme.hljs !== 'object') {
              errors.push(`contributes.themes[${i}].hljs must be an object`);
            }
            if (!theme.terminal || typeof theme.terminal !== 'object') {
              errors.push(`contributes.themes[${i}].terminal must be an object`);
            }
          }
        }
      }
    }

    // v0.7+ contributes.agentConfig validation
    if (contrib.agentConfig !== undefined) {
      if (apiVersion < 0.7) {
        errors.push('contributes.agentConfig requires API >= 0.7');
      } else if (!contrib.agentConfig || typeof contrib.agentConfig !== 'object') {
        errors.push('contributes.agentConfig must be an object');
      } else {
        const ac = contrib.agentConfig as Record<string, unknown>;
        if (ac.skills !== undefined && (typeof ac.skills !== 'object' || ac.skills === null)) {
          errors.push('contributes.agentConfig.skills must be an object');
        }
        if (ac.mcpServers !== undefined && (typeof ac.mcpServers !== 'object' || ac.mcpServers === null)) {
          errors.push('contributes.agentConfig.mcpServers must be an object');
        }
        if (ac.agentTemplates !== undefined && (typeof ac.agentTemplates !== 'object' || ac.agentTemplates === null)) {
          errors.push('contributes.agentConfig.agentTemplates must be an object');
        }
      }
    }

    // v0.7+ contributes.globalDialog validation
    if (contrib.globalDialog !== undefined) {
      if (apiVersion < 0.7) {
        errors.push('contributes.globalDialog requires API >= 0.7');
      } else if (!contrib.globalDialog || typeof contrib.globalDialog !== 'object') {
        errors.push('contributes.globalDialog must be an object');
      } else {
        const gd = contrib.globalDialog as Record<string, unknown>;
        if (typeof gd.label !== 'string' || !gd.label) {
          errors.push('contributes.globalDialog.label must be a non-empty string');
        }
        if (gd.icon !== undefined && typeof gd.icon !== 'string') {
          errors.push('contributes.globalDialog.icon must be a string');
        }
        if (gd.defaultBinding !== undefined && typeof gd.defaultBinding !== 'string') {
          errors.push('contributes.globalDialog.defaultBinding must be a string');
        }
        if (gd.commandId !== undefined && typeof gd.commandId !== 'string') {
          errors.push('contributes.globalDialog.commandId must be a string');
        }
      }
    }
  }

  // Pack plugins must have at least one pack contribution
  if (isPack && m.contributes && typeof m.contributes === 'object') {
    const contrib = m.contributes as Record<string, unknown>;
    const hasPackContribution = contrib.sounds || contrib.themes || contrib.agentConfig;
    if (!hasPackContribution) {
      errors.push('Pack plugins must contribute at least one of: sounds, themes, agentConfig');
    }
  } else if (isPack && !m.contributes) {
    errors.push('Pack plugins must contribute at least one of: sounds, themes, agentConfig');
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
