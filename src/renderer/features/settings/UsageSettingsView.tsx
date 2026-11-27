/**
 * App settings, Usage (docs/usage-attribution.md): each provider's plan
 * limits, and the tokens Clubhouse's agents used, from the local usage log.
 * Read when the page opens and when the period changes; nothing is sent anywhere.
 */
import { useEffect, useState } from 'react';
import type { UsageSummary, UsageSummaryDays } from '../../../shared/usage-summary';
import { SettingsField, SettingsPage, SettingsSection, settingsError, settingsHelp } from './SettingsLayout';
import { quotaText, roleName, usageText } from './usage-format';

export function UsageSettingsView() {
  const [days, setDays] = useState<UsageSummaryDays>(1);
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setError(null);
    window.clubhouse.app.getUsageSummary(days).then(
      (loaded) => { if (alive) setSummary(loaded); },
      // telemetry-exempt: shown on the page.
      (err: unknown) => { if (alive) setError(`Couldn’t read usage. ${err instanceof Error ? err.message : String(err)}`); },
    );
    return () => { alive = false; };
  }, [days]);

  const period = (
    <select
      aria-label="Period"
      value={days}
      onChange={(e) => setDays(Number(e.target.value) as UsageSummaryDays)}
      className="text-xs bg-ctp-mantle border border-surface-1 rounded px-1.5 py-0.5 text-ctp-text"
      data-testid="usage-period"
    >
      <option value={1}>Today</option>
      <option value={7}>Last 7 days</option>
    </select>
  );

  return (
    <SettingsPage
      title="Usage"
      description="Plan limits as each CLI reports them, and the tokens your agents used. Read from this computer only."
      testId="usage-settings"
    >
      {error && <p className={settingsError}>{error}</p>}

      <SettingsSection title="Plan limits">
        {summary?.providers.map((p) => (
          <SettingsField key={p.id} label={p.name} help={quotaText(p.quotaKind, p.quota)} testId={`usage-quota-${p.id}`} />
        ))}
      </SettingsSection>

      <SettingsSection title="Tokens used" meta={summary ? `Since ${summary.since} (UTC)` : undefined} actions={period}>
        {summary?.noLines && (
          <p className={`${settingsHelp} py-2`} data-testid="usage-no-lines">
            {summary.linesRecorded
              ? 'No usage recorded for this period yet.'
              : 'No usage recorded for this period. Usage is recorded while Logging is on, with core:usage on at Info or more detail.'}
          </p>
        )}
        {summary && !summary.noLines && summary.providers.map((p) => (
          <SettingsField key={p.id} label={p.name} help={usageText(p.usage)} testId={`usage-tokens-${p.id}`} />
        ))}
        {summary && !summary.noLines && summary.otherProviders.map((p) => (
          <SettingsField key={p.provider} label={p.provider} help={usageText(p)} />
        ))}
      </SettingsSection>

      {summary && !summary.noLines && (
        <SettingsSection title="By role">
          {summary.roles.map((r) => (
            <SettingsField key={r.role} label={roleName(r.role)} help={usageText(r)} testId={`usage-role-${r.role}`} />
          ))}
        </SettingsSection>
      )}

      <p className={`${settingsHelp} mt-4`}>
        Covers chat, headless and terminal runs. Terminal runs are read from Claude Code and Codex session files; Copilot and Antigravity terminal runs aren’t covered. Input includes cached input.
      </p>
    </SettingsPage>
  );
}
