import { describe, expect, it, vi } from "vitest";

import { requireUserId } from "../convex/lib/auth";

describe("requireUserId", () => {
  it("rejects a signed-out request with one generic message", async () => {
    const ctx = {
      auth: {
        getUserIdentity: vi.fn().mockResolvedValue(null),
      },
    };

    await expect(
      requireUserId(ctx as Parameters<typeof requireUserId>[0]),
    ).rejects.toThrow("Authentication required");
  });

  it("returns the owner id from a signed-in Convex identity", async () => {
    const userId = "jx7abc123";
    const ctx = {
      auth: {
        getUserIdentity: vi.fn().mockResolvedValue({
          subject: `${userId}|session-1`,
        }),
      },
    };

    await expect(
      requireUserId(ctx as Parameters<typeof requireUserId>[0]),
    ).resolves.toBe(userId);
  });
});
