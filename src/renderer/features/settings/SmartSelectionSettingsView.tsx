/**
 * App settings, Smart selection (#3186): Auto, which picks a CLI for a helper,
 * and the models each difficulty picks on each CLI. It moved off the Helpers
 * page because Auto now picks for more than helpers (#2892), and the presets
 * are used by any start that names a difficulty, the Dispatcher's included.
 */

import { HelperPresetsSection } from './HelperPresetsSection';
import { SettingsPage } from './SettingsLayout';

export function SmartSelectionSettingsView() {
  return (
    <SettingsPage
      title="Smart selection"
      description="How Clubhouse picks a CLI and a model when an agent asks it to, by difficulty or with Auto."
      testId="smart-selection-settings"
    >
      <HelperPresetsSection
        title="Auto and presets"
        autoLabel="Smart selection"
        toggleText="Let orchestrators use Smart selection for helpers"
        footer="Smart selection balances load across your providers. Built-in templates ask orchestrators to use it."
      />
    </SettingsPage>
  );
}
