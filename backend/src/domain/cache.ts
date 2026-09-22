import { createClient, type RedisClientType } from 'redis';

type Entry = { expiresAt: number; value: string };

const memory = new Map<string, Entry>();
let redis: RedisClientType | null = null;
let redisFailedUntil = 0;
let redisEventsBound = false;

const disabled = () => ['1', 'true', 'yes', 'on'].includes(
  String(process.env.CACHE_DISABLED ?? '').trim().toLowerCase());

async function client(): Promise<RedisClientType | null> {
  if (disabled() || !process.env.REDIS_URL) return null;
  if (Date.now() < redisFailedUntil) return null;
  if (redis?.isOpen) return redis;

  redis ??= createClient({
    url: process.env.REDIS_URL,
    socket: {
      connectTimeout: Number(process.env.REDIS_CONNECT_TIMEOUT_MS ?? 500),
      reconnectStrategy: false,
    },
  }) as RedisClientType;
  if (!redisEventsBound) {
    redis.on('error', (e) => {
      redisFailedUntil = Date.now() + 30_000;
      console.error('[cache] redis unavailable: %s', (e as Error).message);
    });
    redisEventsBound = true;
  }

  try {
    await redis.connect();
    return redis;
  } catch (e) {
    redisFailedUntil = Date.now() + 30_000;
    console.error('[cache] redis connect failed: %s', (e as Error).message);
    return null;
  }
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  const now = Date.now();
  const local = memory.get(key);
  if (local && local.expiresAt > now) return JSON.parse(local.value) as T;
  if (local) memory.delete(key);

  const r = await client();
  if (!r) return null;
  try {
    const value = await r.get(key);
    return value ? JSON.parse(value) as T : null;
  } catch (e) {
    console.error('[cache] get %s failed: %s', key, (e as Error).message);
    return null;
  }
}

export async function cacheSet(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  const encoded = JSON.stringify(value);
  memory.set(key, { value: encoded, expiresAt: Date.now() + ttlSeconds * 1000 });

  const r = await client();
  if (!r) return;
  try {
    await r.set(key, encoded, { EX: ttlSeconds });
  } catch (e) {
    console.error('[cache] set %s failed: %s', key, (e as Error).message);
  }
}

export async function cacheDeletePrefix(prefix: string): Promise<void> {
  for (const key of memory.keys()) {
    if (key.startsWith(prefix)) memory.delete(key);
  }

  const r = await client();
  if (!r) return;
  try {
    for await (const key of r.scanIterator({ MATCH: `${prefix}*`, COUNT: 100 })) {
      await r.del(key as string);
    }
  } catch (e) {
    console.error('[cache] delete prefix %s failed: %s', prefix, (e as Error).message);
  }
}

export function invalidatePublicTripCache() {
  void cacheDeletePrefix('trips:list:');
  void cacheDeletePrefix('trips:detail:');
}

export async function closeCache(): Promise<void> {
  if (redis?.isOpen) await redis.quit();
  redis = null;
  redisEventsBound = false;
}
