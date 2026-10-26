import type { Limiter } from "./http.ts";
import type { Store } from "../../packages/database/store.ts";

/**
 * Fixed-window limiter whose counters live in the database, so several API instances enforce one limit between them
 * (PORTALOPS_RATE_LIMIT_STORE=database). Same contract as RateLimiter. If the database cannot be reached the request is let through:
 * a rate limiter must never turn a database blip into an outage, and the in-process limits of each instance still apply.
 */
export class SharedRateLimiter implements Limiter {
  private readonly store: Store;
  private readonly name: string;
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private calls = 0;

  constructor(store: Store, name: string, limit: number, windowMs: number, now: () => number = Date.now) {
    this.store = store; this.name = name; this.limit = limit; this.windowMs = windowMs; this.now = now;
  }

  async hit(key: string): Promise<number> {
    const t = this.now();
    try {
      if (++this.calls % 500 === 0) void this.store.pruneRateLimits(t).catch(() => {});
      const { hits, windowEnd } = await this.store.hitRateLimit(this.name + ":" + key, this.windowMs, t);
      return hits > this.limit ? Math.max(1, Math.ceil((windowEnd - t) / 1000)) : 0;
    } catch {
      return 0;
    }
  }
}
