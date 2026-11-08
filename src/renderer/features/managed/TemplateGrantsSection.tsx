/**
 * A template's Clubhouse permissions (#2971, part of #2921): what agents made
 * from it may do through Clubhouse, over the defaults for what the template
 * makes (an orchestrator or not). Each row is Off, Ask first or Allow; a row
 * set back to its default is dropped, so the template only carries what it
 * changes. Starting and removing helpers follow Helper control above.
 */

import { useMemo } from 'react';
import { grantKey, grantRows, isHelperControlRow, type GrantChangeMode, type GrantRow, type TemplateGrant } from '../../../shared/agent-grant-changes';
import { defaultGrants } from '../../../shared/default-grants';
import { templateGrantFacts } from '../../../shared/grant-summary';
import type { ManagedTemplateSettings } from '../../../shared/managed-agents-types';
import { SectionHeading } from '../agents/agentSettingsUi';
import { GrantRowField, groupGrantRows } from '../agents/AgentGrantsSettings';
import { settingsHelp } from '../settings/SettingsLayout';

/** The template's list with one row set; back to the default drops it. */
export function withTemplateRow(grants: readonly TemplateGrant[] | undefined, row: GrantRow, mode: GrantChangeMode, defaultMode: GrantChangeMode): TemplateGrant[] | undefined {
  const rest = (grants ?? []).filter((g) => grantKey(g) !== grantKey(row));
  const next = mode === defaultMode ? rest : [...rest, { action: row.action, target: row.target, mode }];
  return next.length > 0 ? next : undefined;
}

export function TemplateGrantsSection({ settings, onChange }: {
  settings: Pick<ManagedTemplateSettings, 'orchestration' | 'grants'>;
  onChange: (grants: TemplateGrant[] | undefined) => void;
}) {
  const defaults = useMemo(() => defaultGrants(templateGrantFacts(settings.orchestration)), [settings.orchestration]);
  const groups = useMemo(() => {
    const template = (settings.grants ?? []).flatMap((g) => (g.mode === null ? [] : [{ action: g.action, target: g.target, mode: g.mode }]));
    return groupGrantRows(grantRows(defaults, { changes: [], template }));
  }, [defaults, settings.grants]);
  const pureDefault = (row: GrantRow): GrantChangeMode => defaults.find((g) => grantKey(g) === grantKey(row))?.mode ?? 'off';

  return (
    <div data-testid="managed-template-grants">
      <p className={`${settingsHelp} py-2`}>
        What agents made from this template can do to other agents, projects and the app through Clubhouse. Saving pushes a change to the agents you tick, under any change made on an agent itself.
        {' '}It's a guardrail on Clubhouse, not a sandbox.
      </p>
      {groups.map((group) => (
        <section key={group.key} aria-label={group.label} data-testid={`managed-template-grants-group-${group.key}`}>
          <SectionHeading title={group.label} />
          {group.rows.map((row) => (
            <GrantRowField
              key={grantKey(row)}
              row={row}
              targetLabel={group.label}
              note={isHelperControlRow(row) ? 'Follows Helper control.' : undefined}
              mode={row.mode}
              disabled={false}
              error={undefined}
              onChange={(mode) => onChange(withTemplateRow(settings.grants, row, mode, pureDefault(row)))}
            />
          ))}
        </section>
      ))}
    </div>
  );
}
