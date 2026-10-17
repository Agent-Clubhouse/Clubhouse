/**
 * Other (OTLP) destination: OTLP over HTTP/JSON (0.221.x `-http` exporters,
 * which no longer depend on protobufjs). No `-proto` / `-grpc` variants.
 * The OTLP exporters have no Statsbeat equivalent; the egress test still
 * covers them.
 */
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter, AggregationTemporalityPreference } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import * as http from 'http';
import * as https from 'https';
import type { LookupAddress, LookupOptions } from 'dns';
import type { DestinationExporters } from './types';

export interface OtlpDestinationOptions {
  /** Validated base URL (HTTPS, or HTTP to a literal loopback host). */
  endpoint: string;
  headers?: Record<string, string>;
  /**
   * Ports of Clubhouse's own loopback servers (hook server, MCP bridge,
   * Annex), read at connect time because they start after telemetry does.
   */
  reservedPorts?: () => number[];
  /** Cumulative by default, which most OTLP backends expect (spec §6.8). */
  temporality?: 'cumulative' | 'delta';
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/**
 * Resolves only `localhost` and only to loopback, never through the system
 * resolver, so a hosts-file entry can't send plaintext telemetry off the
 * machine (spec §6.8).
 */
export function pinnedLoopbackLookup(hostname: string, options: LookupOptions | LookupCallback, callback?: LookupCallback): void {
  const cb = (typeof options === 'function' ? options : callback) as LookupCallback;
  const opts = typeof options === 'function' ? {} : options;
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const wantV6 = opts.family === 6 || opts.family === 'IPv6';
  const loopback: LookupAddress[] = wantV6 ? [{ address: '::1', family: 6 }] : [{ address: '127.0.0.1', family: 4 }];
  if (host !== 'localhost' && host !== '127.0.0.1' && host !== '::1') {
    const err: NodeJS.ErrnoException = new Error(`Refusing to resolve ${hostname} for plaintext OTLP`);
    err.code = 'ENOTFOUND';
    process.nextTick(() => cb(err, opts.all ? [] : ''));
    return;
  }
  process.nextTick(() => (opts.all ? cb(null, loopback) : cb(null, loopback[0].address, loopback[0].family)));
}

/** Agent factory: plain HTTP is pinned to loopback and kept off Clubhouse's own ports. */
export function createAgentFactory(reservedPorts: () => number[] = () => []) {
  return (protocol: string): http.Agent | https.Agent => {
    if (protocol !== 'http:') return new https.Agent({ keepAlive: true });
    const agent = new http.Agent({ keepAlive: true, lookup: pinnedLoopbackLookup });
    const internal = agent as unknown as {
      createConnection: (opts: { port?: number | string }, cb: (err: Error | null, socket?: unknown) => void) => unknown;
    };
    const base = internal.createConnection.bind(agent);
    internal.createConnection = (opts, cb) => {
      const port = Number(opts.port);
      if (reservedPorts().filter((p) => p > 0).includes(port)) {
        process.nextTick(() => cb(new Error(`Refusing to send OTLP to Clubhouse's own port ${port}`)));
        return undefined;
      }
      return base(opts, cb);
    };
    return agent;
  };
}

export function signalUrl(endpoint: string, signal: 'traces' | 'metrics' | 'logs'): string {
  return `${endpoint.replace(/\/+$/, '')}/v1/${signal}`;
}

export function createOtlpExporters(opts: OtlpDestinationOptions): DestinationExporters {
  const headers = { ...(opts.headers ?? {}) };
  const httpAgentOptions = createAgentFactory(opts.reservedPorts);
  return {
    spanExporter: new OTLPTraceExporter({ url: signalUrl(opts.endpoint, 'traces'), headers, httpAgentOptions }),
    metricExporter: new OTLPMetricExporter({
      url: signalUrl(opts.endpoint, 'metrics'),
      headers,
      httpAgentOptions,
      temporalityPreference: opts.temporality === 'delta'
        ? AggregationTemporalityPreference.DELTA
        : AggregationTemporalityPreference.CUMULATIVE,
    }),
    logExporter: new OTLPLogExporter({ url: signalUrl(opts.endpoint, 'logs'), headers, httpAgentOptions }),
  };
}
