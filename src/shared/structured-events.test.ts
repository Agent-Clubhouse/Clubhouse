import { describe, it, expect } from 'vitest';
import type {
  StructuredEvent,
  StructuredEventType,
  TextDelta,
  TextDone,
  ToolStart,
  ToolOutput,
  ToolEnd,
  FileDiff,
  CommandOutput,
  PermissionRequest,
  PlanUpdate,
  Thinking,
  ErrorEvent,
  UsageEvent,
  EndEvent,
} from './structured-events';

describe('structured-events types', () => {
  it('StructuredEventType covers all expected event types', () => {
    const allTypes: StructuredEventType[] = [
      'text_delta',
      'text_done',
      'tool_start',
      'tool_output',
      'tool_end',
      'file_diff',
      'command_output',
      'permission_request',
      'plan_update',
      'thinking',
      'error',
      'usage',
      'end',
    ];
    expect(allTypes).toHaveLength(13);
  });

  it('constructs a valid TextDelta event', () => {
    const event: StructuredEvent = {
      type: 'text_delta',
      timestamp: Date.now(),
      data: { text: 'hello' } satisfies TextDelta,
    };
    expect(event.type).toBe('text_delta');
    expect((event.data as TextDelta).text).toBe('hello');
  });

  it('constructs a valid TextDone event', () => {
    const event: StructuredEvent = {
      type: 'text_done',
      timestamp: Date.now(),
      data: { text: 'full accumulated text' } satisfies TextDone,
    };
    expect(event.type).toBe('text_done');
  });

  it('constructs a valid ToolStart event', () => {
    const data: ToolStart = {
      id: 'tool-1',
      name: 'Edit',
      displayVerb: 'Editing file',
      input: { file_path: '/src/index.ts' },
    };
    const event: StructuredEvent = { type: 'tool_start', timestamp: Date.now(), data };
    expect((event.data as ToolStart).name).toBe('Edit');
    expect((event.data as ToolStart).displayVerb).toBe('Editing file');
  });

  it('constructs a valid ToolOutput event', () => {
    const data: ToolOutput = { id: 'tool-1', output: 'chunk data', isPartial: true };
    const event: StructuredEvent = { type: 'tool_output', timestamp: Date.now(), data };
    expect((event.data as ToolOutput).isPartial).toBe(true);
  });

  it('constructs a valid ToolEnd event', () => {
    const data: ToolEnd = {
      id: 'tool-1',
      name: 'Edit',
      result: 'File edited successfully',
      durationMs: 150,
      status: 'success',
    };
    const event: StructuredEvent = { type: 'tool_end', timestamp: Date.now(), data };
    expect((event.data as ToolEnd).status).toBe('success');
    expect((event.data as ToolEnd).durationMs).toBe(150);
  });

  it('constructs a valid FileDiff event', () => {
    const data: FileDiff = {
      path: '/src/index.ts',
      changeType: 'modify',
      diff: '--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1 +1 @@\n-old\n+new',
    };
    const event: StructuredEvent = { type: 'file_diff', timestamp: Date.now(), data };
    expect((event.data as FileDiff).changeType).toBe('modify');
  });

  it('constructs a valid CommandOutput event', () => {
    const data: CommandOutput = {
      id: 'cmd-1',
      command: 'npm test',
      status: 'completed',
      output: 'All tests passed',
      exitCode: 0,
    };
    const event: StructuredEvent = { type: 'command_output', timestamp: Date.now(), data };
    expect((event.data as CommandOutput).exitCode).toBe(0);
  });

  it('constructs a valid PermissionRequest event', () => {
    const data: PermissionRequest = {
      id: 'perm-1',
      toolName: 'Bash',
      toolInput: { command: 'rm -rf /tmp/test' },
      description: 'Run command: rm -rf /tmp/test',
    };
    const event: StructuredEvent = { type: 'permission_request', timestamp: Date.now(), data };
    expect((event.data as PermissionRequest).toolName).toBe('Bash');
  });

  it('constructs a valid PlanUpdate event', () => {
    const data: PlanUpdate = {
      steps: [
        { description: 'Read file', status: 'completed' },
        { description: 'Edit file', status: 'in_progress' },
        { description: 'Run tests', status: 'pending' },
      ],
    };
    const event: StructuredEvent = { type: 'plan_update', timestamp: Date.now(), data };
    expect((event.data as PlanUpdate).steps).toHaveLength(3);
  });

  it('constructs a valid Thinking event', () => {
    const data: Thinking = { text: 'Considering approach...', isPartial: false };
    const event: StructuredEvent = { type: 'thinking', timestamp: Date.now(), data };
    expect((event.data as Thinking).isPartial).toBe(false);
  });

  it('constructs a valid ErrorEvent', () => {
    const data: ErrorEvent = { code: 'TOOL_TIMEOUT', message: 'Tool timed out', toolId: 'tool-1' };
    const event: StructuredEvent = { type: 'error', timestamp: Date.now(), data };
    expect((event.data as ErrorEvent).code).toBe('TOOL_TIMEOUT');
  });

  it('constructs a valid UsageEvent', () => {
    const data: UsageEvent = {
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 200,
      costUsd: 0.05,
    };
    const event: StructuredEvent = { type: 'usage', timestamp: Date.now(), data };
    expect((event.data as UsageEvent).inputTokens).toBe(1000);
  });

  it('constructs a valid EndEvent', () => {
    const data: EndEvent = { reason: 'complete', summary: 'Task completed successfully' };
    const event: StructuredEvent = { type: 'end', timestamp: Date.now(), data };
    expect((event.data as EndEvent).reason).toBe('complete');
  });

  it('EndEvent reason covers all variants', () => {
    const reasons: EndEvent['reason'][] = ['complete', 'error', 'cancelled', 'timeout'];
    expect(reasons).toHaveLength(4);
  });

  it('StructuredEvent is JSON-serializable', () => {
    const event: StructuredEvent = {
      type: 'tool_start',
      timestamp: Date.now(),
      data: {
        id: 'test-id',
        name: 'Read',
        displayVerb: 'Reading file',
        input: { file_path: '/test.ts' },
      },
    };
    const serialized = JSON.stringify(event);
    const deserialized = JSON.parse(serialized) as StructuredEvent;
    expect(deserialized.type).toBe('tool_start');
    expect((deserialized.data as ToolStart).name).toBe('Read');
  });
});
