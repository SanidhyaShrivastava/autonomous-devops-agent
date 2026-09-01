type RateLimitEntry = { count: number; windowStartedAt: number };
type RateLimitStore = Map<string, RateLimitEntry>;

const storeSymbol = Symbol.for("gx.runnerRequestRateLimits");
const globalWithStore = globalThis as typeof globalThis & {
  [storeSymbol]?: RateLimitStore;
};
const store = (globalWithStore[storeSymbol] ??= new Map());

function clientAddress(request: Request) {
  const forwarded = request.headers.get("x-forwarded-for");
  return forwarded?.split(",", 1)[0]?.trim() || "address-unavailable";
}

function pruneExpired(now: number, windowMs: number) {
  if (store.size < 1_000) return;
  for (const [key, entry] of store) {
    if (now - entry.windowStartedAt >= windowMs) store.delete(key);
  }
}

export function checkRequestRateLimit(args: {
  request: Request;
  scope: "pair" | "heartbeat";
  identity?: string;
  limit: number;
  windowMs?: number;
}) {
  const now = Date.now();
  const windowMs = args.windowMs ?? 60_000;
  pruneExpired(now, windowMs);
  const key = `${args.scope}:${clientAddress(args.request)}:${args.identity ?? "-"}`;
  const current = store.get(key);
  if (!current || now - current.windowStartedAt >= windowMs) {
    store.set(key, { count: 1, windowStartedAt: now });
    return { allowed: true, retryAfterSeconds: 0 };
  }
  if (current.count >= args.limit) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((current.windowStartedAt + windowMs - now) / 1_000),
      ),
    };
  }
  current.count += 1;
  return { allowed: true, retryAfterSeconds: 0 };
}
