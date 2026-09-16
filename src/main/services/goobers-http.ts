/**
 * Hand-rolled HTTP client for the Goobers daemon API (spec §7.6/§7.3).
 *
 * Modeled on `annex-client.ts`'s `httpGet`/`satelliteHttpsRequest`: plain
 * node `http` (the Goobers API is loopback-only HTTP, never TLS), every
 * request carries a timeout, and `req.destroy()` runs on expiry. There is
 * deliberately no conditional-GET/ETag layer (§7.3) — the API has none.
 *
 * All in-flight requests are tracked so `destroyAllRequests()` can abort
 * them on teardown (§7.9) without depending on the caller keeping a
 * reference to each `ClientRequest`.
 */
import * as http from 'http';

export interface HttpResult {
  status: number;
  body: string;
}

const activeRequests = new Set<http.ClientRequest>();

export function httpGetJson(host: string, port: number, urlPath: string, timeoutMs: number): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host, port, path: urlPath, headers: { Accept: 'application/json' } }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode || 0, body }));
    });

    activeRequests.add(req);
    req.on('close', () => activeRequests.delete(req));

    req.on('error', (err) => reject(err));
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('timeout'));
    });
  });
}

export function parseJsonBody<T>(body: string): T | null {
  try {
    return JSON.parse(body) as T;
  } catch {
    return null;
  }
}

/** Abort every in-flight request. Used on service teardown (§7.9). */
export function destroyAllRequests(): void {
  for (const req of activeRequests) {
    req.destroy();
  }
  activeRequests.clear();
}

/** Test-only accessor. */
export function activeRequestCountForTests(): number {
  return activeRequests.size;
}
