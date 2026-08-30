import { v } from "convex/values";

import { mutation, query } from "./_generated/server";

export const record = mutation({
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

export const latest = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("setupChecks").order("desc").first();
  },
});
