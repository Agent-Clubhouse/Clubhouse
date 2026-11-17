import { describe, expect, it } from 'vitest';
import { connectionApprovalInvolves, connectionApprovalView } from './approval-routing';
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

describe('structured connection approval review', () => {
  it('canonicalizes every exact argument and binds the tool, independently of JSON key order', () => {
    const a = row({ to: `a@${A}`, from: 'b', twoWay: true, allow: ['send_file'], allow_back: ['get_status'] });
    const b = row({ from: 'b', allow_back: ['get_status'], to: `a@${A}`, allow: ['send_file'], twoWay: true });
    expect(connectionApprovalView(a)!.canonical).toBe(connectionApprovalView(b)!.canonical);
    expect(connectionApprovalView(a)).toMatchObject({ from: 'b', to: `a@${A}`, twoWay: true, allow: ['send_file'], allowBack: ['get_status'] });
    expect(connectionApprovalView({ ...a, toolName: 'set_connection_tools' })!.canonical).not.toBe(connectionApprovalView(a)!.canonical);
  });

  it.each([
    { from: 'b', to: `a@${A}`, padding: '' },
    { from: 'b', to: `a@${A}`, twoWay: 'true' },
    { from: 'b', to: `a@${A}`, allow: ['unknown'] },
    { from: 'b', to: `a@${A}`, allow: 'send_file' },
  ])('leaves unsafe arguments visible but unapprovable: %j', (args) => {
    expect(connectionApprovalView(row(args))!.canonical).toBeUndefined();
  });

  it('never approves unknown disconnect tool switches, oversized or unreadable arguments', () => {
    const args = { from: 'b', to: `a@${A}` };
    expect(connectionApprovalView(row({ ...args, allow: ['send_file'] }, { toolName: 'disconnect_agents' }))!.canonical).toBeUndefined();
    expect(connectionApprovalView(row(args, { arguments: JSON.stringify(args) + ' '.repeat(4001) }))!.canonical).toBeUndefined();
    expect(connectionApprovalView(row(args, { arguments: '{' }))!.canonical).toBeUndefined();
    expect(connectionApprovalView(row({ ...args, twoWay: true }, { toolName: 'disconnect_agents' }))!.canonical).toBeDefined();
  });
});
