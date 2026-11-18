'use strict';
const net = require('node:net');

const raw = process.env.CLUBHOUSE_REVERSE_CHILD_GUARD;
if (raw) {
  const allowed = JSON.parse(raw);
  const original = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    let host, port;
    if (first && typeof first === 'object') {
      if (first.path && !('port' in first)) return Reflect.apply(original, this, args);
      host = first.host || 'localhost';
      port = Number(first.port);
    } else if (typeof first === 'number' || typeof first === 'string' && /^\d+$/.test(first)) {
      port = Number(first);
      host = typeof args[1] === 'string' ? args[1] : 'localhost';
    } else if (typeof first === 'string') {
      return Reflect.apply(original, this, args);
    } else {
      throw new Error('Unrecognized child fixture dial');
    }
    // Fake CLIs may use their own authenticated MCP endpoint, never a peer's listener.
    const ownMcp = Number(process.env.CLUBHOUSE_MCP_PORT);
    if (host === '127.0.0.1' && (allowed && port === allowed.port || ownMcp > 0 && port === ownMcp)) {
      return Reflect.apply(original, this, args);
    }
    process.nextTick(() => this.destroy(Object.assign(new Error('Reverse child fixture blocked direct dial'), { code: 'ERR_REVERSE_DIAL_BLOCKED' })));
    return this;
  };
}
