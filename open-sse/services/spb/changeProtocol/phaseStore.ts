import type { PhaseState } from "./types.ts";

const memory = new Map<string, { value: PhaseState; expiresAt: number }>();
let redisWarned = false;

const key = (sessionId: string) => `spb:changeprotocol:phase:${sessionId}`;

async function redis(): Promise<Record<string, unknown> | null> {
  try {
    const mod = await import("@/shared/utils/rateLimiter");
    if (!mod.isRedisConfigured()) return null;
    return (await Promise.resolve(mod.getRedisClient())) || null;
  } catch (err) {
    if (!redisWarned) {
      redisWarned = true;
      console.warn("[ChangeProtocol] Redis unavailable, using in-memory state:", String(err));
    }
    return null;
  }
}

export async function loadState(sessionId: string): Promise<PhaseState | null> {
  const client = await redis();
  if (client) {
    try {
      const raw = await client.get(key(sessionId));
      return raw ? (JSON.parse(raw) as PhaseState) : null;
    } catch (err) {
      if (!redisWarned) {
        redisWarned = true;
        console.warn("[ChangeProtocol] Redis read failed, falling back to memory:", String(err));
      }
    }
  }
  const hit = memory.get(key(sessionId));
  if (!hit || hit.expiresAt < Date.now()) {
    memory.delete(key(sessionId));
    return null;
  }
  return hit.value;
}

export async function saveState(
  sessionId: string,
  state: PhaseState,
  ttlSeconds: number
): Promise<void> {
  const client = await redis();
  if (client) {
    try {
      await client.set(key(sessionId), JSON.stringify(state), "EX", ttlSeconds);
      return;
    } catch (err) {
      if (!redisWarned) {
        redisWarned = true;
        console.warn("[ChangeProtocol] Redis write failed, falling back to memory:", String(err));
      }
    }
  }
  memory.set(key(sessionId), { value: state, expiresAt: Date.now() + ttlSeconds * 1000 });
}
