// Per-client token buckets. In-memory, which matches the single-process
// design (rooms live in memory too).

import type { IncomingMessage } from 'node:http';

interface Bucket {
  tokens: number;
  at: number;
}

export interface Limit {
  /** Maximum burst. */
  capacity: number;
  /** Tokens regained per second. */
  perSecond: number;
}

const buckets = new Map<string, Bucket>();

/** Take `cost` tokens; returns 0 on success or the seconds to wait. */
export function take(key: string, limit: Limit, cost = 1): number {
  const now = Date.now();
  const b = buckets.get(key) ?? { tokens: limit.capacity, at: now };
  b.tokens = Math.min(limit.capacity, b.tokens + ((now - b.at) / 1000) * limit.perSecond);
  b.at = now;
  buckets.set(key, b);
  if (b.tokens >= cost) {
    b.tokens -= cost;
    return 0;
  }
  return Math.ceil((cost - b.tokens) / limit.perSecond);
}

setInterval(() => {
  // Drop buckets idle long enough to have refilled completely.
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [k, b] of buckets) if (b.at < cutoff) buckets.delete(k);
}, 60 * 1000).unref();

const TRUST_PROXY = process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true';

/** Client address; honours X-Forwarded-For only when TRUST_PROXY is set. */
export function clientIp(req: IncomingMessage): string {
  if (TRUST_PROXY) {
    const fwd = req.headers['x-forwarded-for'];
    const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress || 'unknown';
}
