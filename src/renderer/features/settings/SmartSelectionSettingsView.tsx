/**
 * App settings, Smart routing (#3186): Auto, which picks a CLI for a helper,
 * and the models each difficulty picks on each CLI. It moved off the Helpers
 * page because Auto now picks for more than helpers (#2892), and the presets
 * are used by any start that names a difficulty, the Dispatcher's included.
 */

import { HelperPresetsSection } from './HelperPresetsSection';
import { SettingsPage } from './SettingsLayout';

export function SmartSelectionSettingsView() {
  return (
    <SettingsPage
      title="Smart routing"
      description="How Clubhouse picks a CLI and a model when an agent asks it to, by difficulty or with Auto."
      testId="smart-selection-settings"
    >
      <HelperPresetsSection
        title="Smart routing and presets"
        autoLabel="Smart routing"
        toggleText="Let orchestrators use Smart routing for helpers"
        footer="Smart routing balances load across your providers. Built-in templates ask orchestrators to use it."
      />
    </SettingsPage>
  );
}
