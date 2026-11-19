import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GROUP_PROJECT_DISABLED_TOOLS,
  GROUP_PROJECT_DEFAULT_DISABLED_TOOLS_VERSION,
  getDefaultGroupProjectDisabledTools,
  getDefaultGroupProjectDisabledToolsFromMetadata,
} from './group-project-permissions';

describe('group project permission defaults', () => {
  it('defaults all privileged tools off when no metadata exists', () => {
    expect(getDefaultGroupProjectDisabledTools()).toEqual(DEFAULT_GROUP_PROJECT_DISABLED_TOOLS);
    expect(getDefaultGroupProjectDisabledToolsFromMetadata()).toEqual(DEFAULT_GROUP_PROJECT_DISABLED_TOOLS);
  });

  it('adds sleep_agent to legacy persisted defaults without overriding existing choices', () => {
    const legacyDefaults = ['wake_agent', 'broadcast'];
    expect(getDefaultGroupProjectDisabledTools(legacyDefaults)).toEqual(['wake_agent', 'sleep_agent']);
    expect(getDefaultGroupProjectDisabledToolsFromMetadata({ defaultDisabledTools: legacyDefaults })).toEqual([
      'wake_agent',
      'sleep_agent',
    ]);
  });

  it('preserves current-version persisted defaults verbatim', () => {
    expect(getDefaultGroupProjectDisabledTools([], GROUP_PROJECT_DEFAULT_DISABLED_TOOLS_VERSION)).toEqual([]);
    expect(getDefaultGroupProjectDisabledToolsFromMetadata({
      defaultDisabledTools: [],
      defaultDisabledToolsVersion: GROUP_PROJECT_DEFAULT_DISABLED_TOOLS_VERSION,
    })).toEqual([]);
  });
});

it('drops retired and unknown saved default switches without rejecting the settings', () => {
  expect(getDefaultGroupProjectDisabledTools(['shoulder_tap', 'broadcast', 'query_polling', 'toggle_polling', 'nudge_polling', 'unknown', 'wake_agent'], GROUP_PROJECT_DEFAULT_DISABLED_TOOLS_VERSION)).toEqual(['wake_agent']);
});
