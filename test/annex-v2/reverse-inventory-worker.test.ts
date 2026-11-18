import * as net from 'net';
import { describe, it } from 'vitest';
import { createInventoryPeer } from './reverse-inventory-peer';
import { rpcPeer } from './reverse-parity-fixture';

describe.runIf(process.env.CLUBHOUSE_ANNEX_INVENTORY_PEER === '1')('isolated full-server parity peer', () => {
  it('serves the parent over IPC until stopped', async () => {
    const peer = await createInventoryPeer('B');
    let stop!: () => void;
    const stopped = new Promise<void>((resolve) => { stop = resolve; });
    const socket = net.connect(process.env.CLUBHOUSE_ANNEX_INVENTORY_IPC!);
    await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
    let closed = false;
    const rpc = rpcPeer(socket, async (method, params) => {
      switch (method) {
        case 'info': return peer.info;
        case 'configure': return peer.configure(params as Parameters<typeof peer.configure>[0]);
        case 'status': return peer.status();
        case 'wire': return peer.wire(params as Parameters<typeof peer.wire>[0]);
        case 'probe': return peer.probe(params as Parameters<typeof peer.probe>[0]);
        case 'emit': return peer.emit(params as Parameters<typeof peer.emit>[0]);
        case 'driverState': return peer.driverState();
        case 'seedLargeDiff': return peer.seedLargeDiff();
        case 'gitDiff': return peer.gitDiff();
        case 'stop':
          await peer.close();
          closed = true;
          setImmediate(stop);
          return true;
        default: throw new Error(`Unknown inventory fixture method: ${method}`);
      }
    });
    try { await stopped; }
    finally { if (!closed) await peer.close(); rpc.close(); }
  }, 180_000);
});
