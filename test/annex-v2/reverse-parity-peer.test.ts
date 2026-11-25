import * as net from 'net';
import { describe, it } from 'vitest';
import { createClientPeer, type ConfigurePeer, type ConsumerFamily } from './reverse-client-peer';
import { rpcPeer } from './reverse-parity-fixture';

describe.runIf(process.env.CLUBHOUSE_ANNEX_REVERSE_PEER === '1')('isolated reverse consumer peer', () => {
  it('serves the parent over IPC until stopped', async () => {
    const peer = await createClientPeer('B');
    let stop: () => void;
    const stopped = new Promise<void>((resolve) => { stop = resolve; });
    const socket = net.connect(process.env.CLUBHOUSE_ANNEX_REVERSE_IPC!);
    await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
    let closed = false;
    const rpc = rpcPeer(socket, async (method, params) => {
      switch (method) {
        case 'info': return peer.info;
        case 'configure': return peer.configure(params as ConfigurePeer);
        case 'status': return peer.status();
        case 'lowLevel': return peer.lowLevel();
        case 'probe': return peer.probe(params as ConsumerFamily);
        case 'calibrate': return peer.calibrate(params as Array<{ host: string; port: number }>);
        case 'hasHandoff': return peer.hasHandoff(params as string);
        case 'stop':
          await peer.close();
          closed = true;
          setImmediate(() => stop());
          return true;
        default: throw new Error(`Unknown reverse fixture method: ${method}`);
      }
    });
    try { await stopped; }
    finally {
      if (!closed) await peer.close();
      rpc.close();
    }
  }, 120_000);
});
