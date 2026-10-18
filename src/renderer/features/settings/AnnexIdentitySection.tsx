import { AGENT_COLORS } from '../../../shared/name-generator';
import type { AnnexSettings, AnnexStatus } from '../../../shared/types';
import { SettingsField, settingsInput } from './SettingsLayout';

interface Props {
  settings: AnnexSettings;
  status: AnnexStatus;
  onSave: (settings: AnnexSettings) => void;
}

export function AnnexIdentitySection({ settings, status, onSave }: Props) {
  return (
    <>
      <SettingsField label="Alias" help="How this machine appears to other Clubhouse instances." htmlFor="annex-alias">
        <input
          id="annex-alias"
          type="text"
          value={settings.alias}
          onChange={(e) => onSave({ ...settings, alias: e.target.value })}
          className={`${settingsInput} w-[220px]`}
          placeholder="My Mac"
        />
      </SettingsField>

      <SettingsField label="Color">
        <div className="flex gap-1.5">
          {AGENT_COLORS.map((color) => {
            const selected = settings.color === color.id;
            return (
              <button
                key={color.id}
                type="button"
                aria-label={color.label}
                aria-pressed={selected}
                onClick={() => onSave({ ...settings, color: color.id })}
                className="w-5 h-5 rounded-full cursor-pointer focus-ring"
                style={{
                  backgroundColor: color.hex,
                  ...(selected ? { outline: `2px solid ${color.hex}`, outlineOffset: 2 } : {}),
                }}
                title={color.label}
              />
            );
          })}
        </div>
      </SettingsField>

      {status.fingerprint && (
        <SettingsField
          label="Fingerprint"
          help={<span className="font-mono select-all break-all">{status.fingerprint}</span>}
        />
      )}
    </>
  );
}
