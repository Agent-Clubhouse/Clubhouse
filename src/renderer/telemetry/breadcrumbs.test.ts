/**
 * The silent failure #2303 guards against: feedback breadcrumbs used to come
 * only through the legacy log path (`log:write` into log-service's tap), and
 * that path is gone (#2313). Here the preload bridge goes straight to main's
 * validator, as the `feedback:record-breadcrumb` handler does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetBreadcrumbsForTests, recentBreadcrumbs, recordRendererBreadcrumb } from '../../main/services/breadcrumbs';
import { reportChromeView } from '../chrome/telemetry';
import { switchAgentRuntime } from '../features/agents/chat/AgentRuntimePane';
import { useProjectStore } from '../stores/projectStore';
import { _resetUiPerfForTests, _flushUiPerfForTests, handleLongFrame } from './ui-perf';
import type { Agent } from '../../shared/types';

const agent = { id: 'a1', projectId: 'missing', name: 'agent', kind: 'durable' } as unknown as Agent;

let restore: Array<() => void> = [];

beforeEach(() => {
  _resetBreadcrumbsForTests(() => 1_000);
  // Over IPC, the way main's handler receives it.
  const record = vi.spyOn(window.clubhouse.feedback, 'recordBreadcrumb').mockImplementation((crumb) => {
    recordRendererBreadcrumb(structuredClone(crumb));
  });
  restore = [() => record.mockRestore()];
});

afterEach(() => {
  for (const r of restore) r();
  _resetUiPerfForTests();
  _resetBreadcrumbsForTests();
});

describe('feedback breadcrumbs without the legacy log path (#2303)', () => {
  it('a long frame, a view change and a runtime switch each reach recentBreadcrumbs()', async () => {
    handleLongFrame({ duration: 640 });
    _flushUiPerfForTests();
    reportChromeView('plugin:files');
    useProjectStore.setState({ projects: [] } as never);
    await expect(switchAgentRuntime(agent, 'chat')).rejects.toThrow('Project not found');

    expect(recentBreadcrumbs().map((b) => [b.kind, b.code, b.value])).toEqual(expect.arrayContaining([
      ['performance', 'ui.long_frame', 640],
      ['event', 'view.files', undefined],
      ['event', 'runtime.switch.chat', undefined],
      ['error', 'runtime.switch_failed.chat', undefined],
    ]));
    expect(recentBreadcrumbs()).toHaveLength(4);
  });
});
