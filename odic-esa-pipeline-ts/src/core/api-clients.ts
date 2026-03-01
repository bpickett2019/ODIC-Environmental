/**
 * HTTP fetch utility for external API calls.
 * Provides retry, timeout, rate-limiting, and structured error handling.
 */

import pino from 'pino';

const logger = pino({ name: 'APIClient', level: process.env.LOG_LEVEL || 'info' });

/** Rate limiter: tracks last call time per domain */
const domainTimestamps = new Map<string, number>();

export interface FetchOptions {
  /** Timeout in milliseconds (default 15000) */
  timeout?: number;
  /** Number of retries (default 1 = no retry) */
  retries?: number;
  /** Additional headers */
  headers?: Record<string, string>;
  /** Minimum ms between calls to the same domain (for rate limiting) */
  rateLimitMs?: number;
  /** HTTP method (default GET) */
  method?: string;
  /** Request body (for POST) */
  body?: string;
}

/**
 * Fetch with retry, timeout, and rate-limiting.
 * Returns parsed JSON or null on failure.
 */
export async function fetchWithRetry<T = any>(
  url: string,
  options: FetchOptions = {}
): Promise<T | null> {
  const {
    timeout = 15000,
    retries = 1,
    headers = {},
    rateLimitMs = 0,
    method = 'GET',
    body,
  } = options;

  // Rate limiting per domain
  if (rateLimitMs > 0) {
    const domain = new URL(url).hostname;
    const lastCall = domainTimestamps.get(domain) || 0;
    const elapsed = Date.now() - lastCall;
    if (elapsed < rateLimitMs) {
      await new Promise(resolve => setTimeout(resolve, rateLimitMs - elapsed));
    }
    domainTimestamps.set(domain, Date.now());
  }

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);

      const response = await fetch(url, {
        method,
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'ODIC-ESA-Pipeline/1.0 (Environmental Research)',
          ...headers,
        },
        body,
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json() as T;
      return data;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ url, attempt, retries, error: msg }, `Fetch failed (attempt ${attempt}/${retries})`);

      if (attempt < retries) {
        await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt - 1) * 1000));
      }
    }
  }

  return null;
}

/**
 * Fetch raw response (for binary data like images).
 * Returns Buffer or null on failure.
 */
export async function fetchBuffer(
  url: string,
  options: FetchOptions = {}
): Promise<Buffer | null> {
  const { timeout = 15000, headers = {} } = options;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'ODIC-ESA-Pipeline/1.0 (Environmental Research)',
        ...headers,
      },
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const arrayBuf = await response.arrayBuffer();
    return Buffer.from(arrayBuf);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ url, error: msg }, 'Buffer fetch failed');
    return null;
  }
}

/**
 * Query multiple APIs in parallel with fault tolerance.
 * Returns results keyed by source name.
 */
export async function queryAllSources<T>(
  queries: Array<{
    name: string;
    fn: () => Promise<T | null>;
  }>
): Promise<Map<string, { status: 'success' | 'failed'; data: T | null; error?: string }>> {
  const results = await Promise.allSettled(
    queries.map(async q => {
      const data = await q.fn();
      return { name: q.name, data };
    })
  );

  const map = new Map<string, { status: 'success' | 'failed'; data: T | null; error?: string }>();

  results.forEach((result, i) => {
    const name = queries[i].name;
    if (result.status === 'fulfilled' && result.value.data !== null) {
      map.set(name, { status: 'success', data: result.value.data });
    } else {
      const error = result.status === 'rejected'
        ? (result.reason instanceof Error ? result.reason.message : String(result.reason))
        : 'No data returned';
      map.set(name, { status: 'failed', data: null, error });
    }
  });

  return map;
}
