import { describe, expect, it } from 'vitest';
import { connectionApprovalInvolves } from './approval-routing';
import type { MobileGrantRequest } from './mobile-control';

const A = Array(16).fill('ab').join(':');
const B = Array(32).fill('cd').join(':');
const row = (args: unknown, over: Partial<MobileGrantRequest> = {}) => ({
  kind: 'call', actions: ['connection.manage'], toolName: 'connect_agents', arguments: JSON.stringify(args), ...over,
} as MobileGrantRequest);

describe('ownership of another computer’s connection approval (#3654)', () => {
  it.each(['connect_agents', 'disconnect_agents', 'set_connection_tools'])('reads either endpoint of %s, normalized, without requiring that agent to exist', (toolName) => {
    for (const args of [{ from: 'local', to: `nonexistent@${A.toUpperCase()}` }, { from: `other@${A}`, to: 'local' }]) {
      expect(connectionApprovalInvolves(row(args, { toolName }), A.toUpperCase())).toBe(true);
    }
  });

  it.each([
    null, [], 'agent', {}, { from: 'a' }, { from: 1, to: `a@${A}` },
    { from: 'a', to: 'local' }, { from: 'a', to: `a@${B}` },
    { from: 'a', to: `a@${A}:zz` }, { from: 'a', to: `a@${A} ` },
    { from: 'a', to: `@${A}` }, { from: 'a', to: `a@other@${A}` },
  ])('fails closed for unrelated or malformed arguments %j', (args) => {
    expect(connectionApprovalInvolves(row(args), A)).toBe(false);
  });

  it('ignores malformed JSON, absent identity, display fields, unrelated tools/actions and lasting asks', () => {
    const yes = row({ from: 'a', to: `a@${A}` });
    for (const over of [
      { arguments: '{' }, { kind: 'grant' as const }, { actions: ['agent.read'] }, { toolName: 'join_group_project' },
      { arguments: '{}', summary: `connect to a@${A}`, where: A, detail: A, target: { kind: 'agent' as const } },
    ]) expect(connectionApprovalInvolves({ ...yes, ...over }, A)).toBe(false);
    expect(connectionApprovalInvolves(yes, undefined)).toBe(false);
  });
});
