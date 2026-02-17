/**
 * In-memory cache for model list API responses.
 * 30-minute TTL to avoid rate limits on Anthropic and Cursor APIs.
 */

const TTL_MS = 30 * 60 * 1000; // 30 minutes

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry<unknown>>();

/**
 * Get a cached value if it exists and has not expired.
 */
export function get<T>(key: string): T | undefined {
  const entry = cache.get(key) as CacheEntry<T> | undefined;
  if (!entry || Date.now() >= entry.expiresAt) {
    if (entry) cache.delete(key);
    return undefined;
  }
  return entry.value;
}

/**
 * Store a value with the given TTL (default 30 minutes).
 */
export function set<T>(key: string, value: T, ttlMs: number = TTL_MS): void {
  cache.set(key, {
    value,
    expiresAt: Date.now() + ttlMs,
  });
}

/**
 * Clear the cache (useful for tests).
 */
export function clear(): void {
  cache.clear();
}
