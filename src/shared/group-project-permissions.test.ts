import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GROUP_PROJECT_DISABLED_TOOLS,
  GROUP_PROJECT_DEFAULT_DISABLED_TOOLS_VERSION,
  GROUP_PROJECT_CORE_TOOL_SUFFIXES,
  GROUP_PROJECT_PRIVILEGED_TOOL_SUFFIXES,
  getDefaultGroupProjectDisabledTools,
  getDefaultGroupProjectDisabledToolsFromMetadata,
} from './group-project-permissions';

describe('group project polling tool suffixes', () => {
  it('classifies query_polling as core (non-privileged)', () => {
    expect(GROUP_PROJECT_CORE_TOOL_SUFFIXES).toContain('query_polling');
    expect(GROUP_PROJECT_PRIVILEGED_TOOL_SUFFIXES).not.toContain('query_polling');
  });

  it('classifies toggle_polling and nudge_polling as privileged (admin)', () => {
    expect(GROUP_PROJECT_PRIVILEGED_TOOL_SUFFIXES).toContain('toggle_polling');
    expect(GROUP_PROJECT_PRIVILEGED_TOOL_SUFFIXES).toContain('nudge_polling');
  });

  it('drops the old per-agent start_polling / stop_polling suffixes entirely', () => {
    const all = [...GROUP_PROJECT_CORE_TOOL_SUFFIXES, ...GROUP_PROJECT_PRIVILEGED_TOOL_SUFFIXES] as string[];
    expect(all).not.toContain('start_polling');
    expect(all).not.toContain('stop_polling');
  });
});

describe('group project permission defaults', () => {
  it('defaults all privileged tools off when no metadata exists', () => {
    expect(getDefaultGroupProjectDisabledTools()).toEqual(DEFAULT_GROUP_PROJECT_DISABLED_TOOLS);
    expect(getDefaultGroupProjectDisabledToolsFromMetadata()).toEqual(DEFAULT_GROUP_PROJECT_DISABLED_TOOLS);
  });

  it('adds sleep_agent to legacy persisted defaults without overriding existing choices', () => {
    const legacyDefaults = ['wake_agent', 'broadcast'];
    expect(getDefaultGroupProjectDisabledTools(legacyDefaults)).toEqual(['wake_agent', 'broadcast', 'sleep_agent']);
    expect(getDefaultGroupProjectDisabledToolsFromMetadata({ defaultDisabledTools: legacyDefaults })).toEqual([
      'wake_agent',
      'broadcast',
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
