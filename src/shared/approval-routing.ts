import { parseAgentAddress } from './agent-address';
import type { MobileGrantRequest } from './mobile-control';
import { CONNECTION_SWITCHES } from './connection-grants';

type ApprovalRow = Pick<MobileGrantRequest, 'kind' | 'actions' | 'toolName' | 'arguments'>;
export const CONNECTION_APPROVAL_ARGUMENTS_MAX = 4_000;

export function isConnectionApproval(row: ApprovalRow): boolean {
  return row.kind === 'call' && row.actions.includes('connection.manage')
    && ['connect_agents', 'disconnect_agents', 'set_connection_tools'].includes(row.toolName ?? '');
}

export interface ConnectionApprovalView {
  tool: string;
  from?: string;
  to?: string;
  twoWay?: boolean;
  allow?: string[];
  allowBack?: string[];
  /** Present only when every argument can be safely represented in the structured view. */
  canonical?: string;
}

/** Parse known fields even on an unsafe row, so padding cannot hide the operation. */
export function connectionApprovalView(row: ApprovalRow): ConnectionApprovalView | null {
  if (!isConnectionApproval(row)) return null;
  const view: ConnectionApprovalView = { tool: row.toolName! };
  try {
    const args: unknown = row.arguments ? JSON.parse(row.arguments) : null;
    if (!args || typeof args !== 'object' || Array.isArray(args)) return view;
    const a = args as Record<string, unknown>;
    if (typeof a.from === 'string') view.from = a.from;
    if (typeof a.to === 'string') view.to = a.to;
    if (a.twoWay === undefined && a.two_way === undefined) view.twoWay = false;
    else if (typeof (a.twoWay ?? a.two_way) === 'boolean') view.twoWay = (a.twoWay ?? a.two_way) as boolean;
    const tools = (value: unknown): value is string[] => Array.isArray(value) && value.every((v) => typeof v === 'string');
    if (tools(a.allow)) view.allow = a.allow;
    if (tools(a.allow_back)) view.allowBack = a.allow_back;
    const keys = row.toolName === 'disconnect_agents' ? ['from', 'to', 'twoWay']
      : ['from', 'to', 'twoWay', 'allow', 'allow_back', ...(row.toolName === 'set_connection_tools' ? ['two_way'] : [])];
    const validTools = (value: unknown) => value === undefined || tools(value)
      && value.length <= CONNECTION_SWITCHES.length && value.every((v) => CONNECTION_SWITCHES.some((s) => s.tool === v));
    const validEnd = (value: unknown) => typeof value === 'string' && !!value.trim() && value.length <= 400
      && !/[\u0000-\u001f\u007f]/.test(value);
    if ((row.arguments?.length ?? 0) > CONNECTION_APPROVAL_ARGUMENTS_MAX || Object.keys(a).some((key) => !keys.includes(key))
      || !validEnd(a.from) || !validEnd(a.to) || view.twoWay === undefined
      || a.twoWay !== undefined && typeof a.twoWay !== 'boolean' || a.two_way !== undefined && typeof a.two_way !== 'boolean'
      || a.twoWay !== undefined && a.two_way !== undefined && a.twoWay !== a.two_way
      || !validTools(a.allow) || !validTools(a.allow_back) || row.toolName === 'set_connection_tools' && a.allow === undefined) return view;
    // Bind the operation and every exact argument, including aliases and array order.
    view.canonical = JSON.stringify({ tool: row.toolName, actions: [...row.actions].sort(), args: Object.fromEntries(Object.keys(a).sort().map((key) => [key, a[key]])) });
    return view;
  } catch {
    // telemetry-exempt: unsafe stored arguments remain visible but cannot be approved here
    return view;
  }
}

/**
 * Whether another computer's pending call involves this computer (#3654).
 * Only stored connection arguments confer ownership. Bare references belong
 * to the requesting computer; display text and lasting grant asks do not.
 */
export function connectionApprovalInvolves(
  row: ApprovalRow,
  machine: string | null | undefined,
): boolean {
  if (!machine || !isConnectionApproval(row)) return false;
  try {
    const args: unknown = row.arguments ? JSON.parse(row.arguments) : null;
    if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
    const { from, to } = args as Record<string, unknown>;
    if (typeof from !== 'string' || !from || typeof to !== 'string' || !to) return false;
    return [from, to].some((ref) => {
      const end = parseAgentAddress(ref);
      return !end.agentId.includes('@') && end.machine === machine.toLowerCase();
    });
  } catch {
    // telemetry-exempt: malformed stored arguments confer no ownership
    return false;
  }
}
