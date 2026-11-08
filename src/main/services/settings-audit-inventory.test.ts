import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * Pins what the settings audit covers (#2671), so a new settings file or writer
 * is a decision and not something that quietly goes unrecorded.
 */

const MAIN = path.join(__dirname, '..');

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__fixtures__' ? [] : sources(full);
    return /\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) ? [full] : [];
  });
}

/** A call's text, from `createSettingsStore<` to its closing parenthesis. */
function wholeCall(text: string, start: number): string {
  let depth = 0;
  for (let i = text.indexOf('(', start); i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return text.slice(start, i + 1);
  }
  return text.slice(start);
}

/** Not a person's choices: where the app keeps its own place. */
const NOT_SETTINGS = new Set([
  'annex-ports.json',
  'finished-quick-agents.json',
  'project-state.json',
  'chat-cli-denylist.json',
  // Auto's last fair-tie choice is internal scheduling history, not a person's setting.
  'helper-auto-rotation.json',
]);

describe('settings audit inventory', () => {
  it('every settings store either reports to the audit or is named here as not settings', () => {
    const missing: string[] = [];
    for (const file of sources(MAIN)) {
      if (file.endsWith('settings-store.ts')) continue;
      const text = fs.readFileSync(file, 'utf8');
      for (const match of text.matchAll(/createSettingsStore</g)) {
        const call = wholeCall(text, match.index);
        if (call.includes('audit:')) continue;
        const name = /'([^']+\.json)'/.exec(call)?.[1] ?? path.relative(MAIN, file);
        if (!NOT_SETTINGS.has(name)) missing.push(name);
      }
    }
    expect(missing).toEqual([]);
  });

  it('the writers a person reaches are hooked', () => {
    const read = (rel: string) => fs.readFileSync(path.join(MAIN, rel), 'utf8');
    expect(read('services/agent-config.ts')).toContain("auditChanges('agent', 'agent', agentId, auditBefore, pickAudited(agent, AGENT_AUDIT_CATALOG)");
    expect(read('services/agent-config.ts')).toContain('AGENT_IDENTITY_AUDIT_CATALOG), AGENT_IDENTITY_AUDIT_CATALOG');
    expect(read('services/project-store.ts')).toContain("auditChanges('project', 'project', id");
    expect(read('services/agent-settings-service.ts')).toContain("auditChanges('project', 'project.defaults'");
    expect(read('services/orchestration-policy.ts')).toContain('auditPolicyChange(audit, storedBefore, stored)');
    expect(read('services/helper-routing.ts')).toContain('auditPresetChanges(before, result, surface)');
    expect(read('services/asset-catalog/store.ts')).toContain("auditCommitted('app', `assetCatalog.${entry.kind}.revision`, entry.id)");
    expect(read('services/asset-catalog/store.ts')).toContain("auditCommitted('agent', 'assetCatalog.composition', input.agentId)");
    expect(read('services/asset-catalog/store.ts')).toContain("auditCommitted('agent', 'assetCatalog.structure', agentId)");
    expect(read('services/asset-catalog/store.ts')).toContain("auditCommitted('app', 'assetCatalog.template.published', input.templateId)");
    expect(read('ipc/index.ts')).toContain('enableSettingsAudit()');
  });

  it('managed agents\' setups, parts, templates and helper settings are hooked (D13)', () => {
    const read = (rel: string) => fs.readFileSync(path.join(MAIN, rel), 'utf8');
    // Every setup write, whoever makes it (the builder, a push, a fork, a helper's start, unmanage).
    expect(read('services/agent-config.ts')).toContain("auditChanges('agent', 'agent', agentId, managedBefore, managedAuditFields(agent), MANAGED_AUDIT_CATALOG)");
    expect(read('services/agent-config.ts')).toContain("{ clubhouseFeatures: 'value' }");
    // managed-agents/state.json isn't a settings store: its writers report by key.
    const service = read('services/managed-agents/service.ts');
    for (const key of ['managed.part.created', 'managed.part.updated', 'managed.part.deleted', 'managed.template.saved', 'managed.template.deleted', 'managed.template.pushed']) {
      expect(service).toContain(`auditManaged('${key}'`);
    }
    expect(service).toContain("auditManagedSetting('defaultHelperTemplate'");
    expect(service).toContain("auditManagedSetting('helperTemplateChoice'");
  });

  it('each entry point says who is asking', () => {
    const read = (rel: string) => fs.readFileSync(path.join(MAIN, rel), 'utf8');
    expect(read('ipc/validation.ts')).toContain("withSettingsSurface('ui'");
    expect(read('services/clubhouse-mcp/tool-registry.ts')).toContain("withSettingsSurface('mcp', agentId");
    expect(read('services/mobile-control.ts')).toContain("withSettingsSurface('mobile'");
    expect(read('services/cli-endpoint.ts')).toContain("withSettingsSurface('cli'");
    // Personas were retired (#2901): the 'persona' surface stays for the orchestration fields carried from the old persona layer.
    expect(read('services/orchestration-policy.ts')).toContain("surface: 'persona'");
  });
});
