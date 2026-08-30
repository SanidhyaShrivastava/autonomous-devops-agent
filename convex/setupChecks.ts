import { v } from "convex/values";

import { internalMutation, internalQuery } from "./_generated/server";

export const record = internalMutation({
  args: {
    label: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("setupChecks", {
      label: args.label,
      createdAt: Date.now(),
    });
  },
});

export const latest = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("setupChecks").order("desc").first();
  },
});
