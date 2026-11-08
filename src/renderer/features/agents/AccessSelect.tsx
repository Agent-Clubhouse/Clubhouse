import { useEffect } from 'react';
import {
  ACCESS_DESCRIPTIONS, accessLabel, accessLevelsFor, type AccessLevel, type AccessRuntime,
} from '../../../shared/agent-access';
import { useDefaultAccessStore } from '../../stores/defaultAccessStore';

interface AccessSelectProps {
  value: AccessLevel;
  onChange: (level: AccessLevel) => void;
  /** The CLI the agent runs. Its levels are the only ones offered. */
  providerId: string | undefined;
  /** Chat or terminal, when known. Unknown offers the levels either has. */
  runtime?: AccessRuntime;
  className?: string;
  disabled?: boolean;
  id?: string;
  'aria-label'?: string;
  'data-testid'?: string;
}

/**
 * The Access picker (#2761): one level from the five-level ladder, limited to
 * the levels this CLI can start at. A saved level the CLI doesn't have stays
 * listed, marked, so opening the picker never changes it.
 */
export function AccessSelect({ value, onChange, providerId, runtime, className, disabled, id, ...rest }: AccessSelectProps) {
  const levels = accessLevelsFor(providerId, runtime);
  const options = levels.includes(value) ? levels : [...levels, value];
  return (
    <select
      id={id}
      aria-label={rest['aria-label'] ?? 'Access'}
      data-testid={rest['data-testid']}
      value={value}
      disabled={disabled}
      title={ACCESS_DESCRIPTIONS[value]}
      onChange={(e) => onChange(e.target.value as AccessLevel)}
      className={className}
    >
      {options.map((level) => (
        <option key={level} value={level}>
          {accessLabel(level)}{levels.includes(level) ? '' : ' (not available for this CLI)'}
        </option>
      ))}
    </select>
  );
}

/** One plain sentence about a level, for the help line under a picker. */
export function accessHelp(level: AccessLevel): string {
  return ACCESS_DESCRIPTIONS[level];
}

/** The app's Default access, loaded on first use. */
export function useDefaultAccess(): AccessLevel {
  const level = useDefaultAccessStore((s) => s.defaultAccess);
  const load = useDefaultAccessStore((s) => s.loadDefaultAccess);
  useEffect(() => { void load(); }, [load]);
  return level;
}
