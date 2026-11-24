import { createHash } from 'node:crypto';
import { Script } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import historical from './__fixtures__/annex-beta12-snapshot-case.json';

// The actual beta.12 switch case, not an oracle copied from the modern decoder.
// This exercises the historical decode branch, not a complete old app/connection.
function decode(payload: Record<string, unknown>) {
  expect(createHash('sha256').update(historical.caseSource).digest('hex'))
    .toBe('1dd7bc68747e2f16a9f4a03ad9bbfb6a47d982de3d0d7483cb6333fe550e93c1');
  expect(historical.caseSource.split(' as SatelliteSnapshot')).toHaveLength(2);
  const code = historical.caseSource.replace(' as SatelliteSnapshot', '');
  const sat: { id: string; fingerprint: string; snapshot?: unknown; lastError: string | null } = {
    id: 'historical-peer', fingerprint: 'historical-peer', lastError: null,
  };
  const setState = vi.fn(), broadcast = vi.fn();
  new Script(`(function historicalHandler() { switch (msg.type) { ${code} } })();`).runInNewContext({
    sat, msg: JSON.parse(JSON.stringify({ type: 'snapshot', payload })),
    ANNEX_PROTOCOL_VERSION: historical.protocolVersion,
    setState, connectSucceeded: vi.fn(), broadcastSatellitesChanged: vi.fn(),
    broadcastSatelliteEvent: broadcast,
  });
  return { sat, setState, broadcast };
}

describe('historical desktop snapshot decoder (#3784)', () => {
  it.each([undefined, 1, 2, '1'])('accepts protocol2 with an optional run-state declaration %s without disconnect', (marker) => {
    const payload: Record<string, unknown> = { protocolVersion: 2, lastSeq: 1, projects: [], agents: {}, quickAgents: {},
      ...(marker !== undefined && { agentRunStateVersion: marker }) };
    const result = decode(payload);
    expect(result.setState).not.toHaveBeenCalled();
    expect(result.sat.snapshot).toEqual(payload);
    expect(result.broadcast).toHaveBeenCalledWith('historical-peer', 'snapshot', payload);
  });

  it('still refuses an incompatible protocol, proving the frozen case actually validates', () => {
    const result = decode({ protocolVersion: 99, lastSeq: 1, agentRunStateVersion: 1 });
    expect(result.setState).toHaveBeenCalledWith(result.sat, 'disconnected', 'Incompatible Annex version');
    expect(result.sat.snapshot).toBeUndefined();
    expect(result.broadcast).not.toHaveBeenCalled();
  });
});
