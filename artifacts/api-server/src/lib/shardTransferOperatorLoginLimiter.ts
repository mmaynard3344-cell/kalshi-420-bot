/**
 * Fixed-window login attempt limiter for a single server process.
 * An eventual production login must additionally use a shared durable store
 * across Railway replicas and IP/proxy-aware identity extraction.
 */
export function createShardOperatorLoginLimiter(config: { limit: number; windowMs: number; maxKeys: number }) {
  if (!Number.isSafeInteger(config.limit) || config.limit < 1 ||
      !Number.isSafeInteger(config.windowMs) || config.windowMs < 1000 ||
      !Number.isSafeInteger(config.maxKeys) || config.maxKeys < 1) throw new Error("Invalid limiter settings");
  const entries = new Map<string, { count: number; expires: number }>();
  return {
    allow(identity: string, now: number): boolean {
      if (!identity || identity.length > 256 || !Number.isSafeInteger(now) || now < 0) return false;
      const old = entries.get(identity);
      if (old && now < old.expires) {
        old.count += 1;
        return old.count <= config.limit;
      }
      if (entries.size >= config.maxKeys) {
        for (const [key, item] of entries) if (now >= item.expires) entries.delete(key);
        if (entries.size >= config.maxKeys && !entries.has(identity)) return false;
      }
      entries.set(identity, { count: 1, expires: now + config.windowMs });
      return true;
    },
  };
}
